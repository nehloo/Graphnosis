import type {
  KnowledgeGraph,
  QueryResult,
  TfidfIndex,
  SubgraphContext,
  GraphNode,
  DirectedEdge,
  UndirectedEdge,
  NodeId,
} from '@/core/types';
import { findSeeds, type ScoredSeed } from './seed-finder';
import { traverseGraph } from './traverser';
import { serializeSubgraph } from './subgraph-serializer';
import { decomposeQuery } from './query-decomposer';
import { buildSynonymMap, expandQuery } from './synonym-expander';

// Enhanced query engine with synonym expansion and query decomposition

export interface QueryOptions {
  maxNodes?: number; // Override the default subgraph size cap
  maxSeeds?: number; // Cap on merged seeds after sub-query expansion (default 24)
  diversify?: boolean; // Round-robin seeds across source files to cover multi-session questions (default true)
  questionDate?: string; // ISO "YYYY-MM-DD [(Day)]" treated as today; enables date-aware seed augmentation
}

export function queryGraph(
  graph: KnowledgeGraph,
  tfidfIndex: TfidfIndex,
  question: string,
  opts: QueryOptions = {}
): Omit<QueryResult, 'answer'> {
  const maxSeeds = opts.maxSeeds ?? 24;
  const diversify = opts.diversify ?? true;

  // Step 1: Decompose complex queries into sub-queries
  const { subQueries } = decomposeQuery(question);

  // Step 2: Expand each sub-query with synonyms from the graph
  const synonymMap = buildSynonymMap(graph);
  const allQueries: string[] = [];
  for (const sq of subQueries) {
    const expanded = expandQuery(sq, synonymMap);
    allQueries.push(...expanded);
  }

  // Deduplicate
  const uniqueQueries = [...new Set(allQueries)];

  // Step 3: Find seeds across all query variants and merge
  const seedMap = new Map<string, ScoredSeed>();
  for (const q of uniqueQueries) {
    const seeds = findSeeds(q, tfidfIndex);
    for (const seed of seeds) {
      const existing = seedMap.get(seed.nodeId);
      if (!existing || seed.score > existing.score) {
        seedMap.set(seed.nodeId, seed);
      }
    }
  }

  // Step 3b: Date-aware seed augmentation. Questions like "what did I do
  // last month" rarely have keyword overlap with the session that holds
  // the answer (today's session keeps mentioning the topic; the original
  // event session is brief). Parse temporal phrases against today's date
  // and force-include top-scoring nodes from sessions whose date falls
  // in the target range.
  if (opts.questionDate) {
    const dateBonus = augmentSeedsByDate(graph, tfidfIndex, question, opts.questionDate, seedMap);
    for (const seed of dateBonus) {
      if (!seedMap.has(seed.nodeId)) seedMap.set(seed.nodeId, seed);
    }
  }

  // Merge into a final seed list. Multi-part / multi-session questions
  // benefit from seeds spread across different source files; otherwise
  // TF-IDF tends to cluster the top-N in one dominant session and BFS
  // never reaches the other evidence. Round-robin by source file when
  // diversify is on, falling back to pure-score order.
  const sortedSeeds = Array.from(seedMap.values()).sort((a, b) => b.score - a.score);
  const mergedSeeds = diversify
    ? diversifySeedsBySource(sortedSeeds, graph, maxSeeds)
    : sortedSeeds.slice(0, maxSeeds);

  if (mergedSeeds.length === 0) {
    return {
      subgraph: {
        nodes: [],
        directedEdges: [],
        undirectedEdges: [],
        serialized: '=== KNOWLEDGE SUBGRAPH (0 nodes, 0 edges) ===\nNo relevant nodes found for this query.',
      },
      seeds: [],
    };
  }

  // Step 4: Traverse graph from merged seeds
  const traversalResult = traverseGraph(graph, mergedSeeds, undefined, opts.maxNodes);

  // Step 4b: Sibling-turn expansion. For each retrieved Assistant chunk,
  // also include the User chunk(s) from the same turn pair. User questions
  // routinely carry the key fact ("I bought X yesterday") but lose the
  // TF-IDF battle to longer assistant responses, so they get evicted from
  // the seed pool. Without them the model has no grounding for "what did I
  // X" questions even when the right session is retrieved.
  const expanded = expandWithSiblingTurns(graph, traversalResult);

  // Step 5: Serialize with enrichment data (synthesis + context) if available
  const subgraph = serializeEnrichedSubgraph(
    expanded.nodes,
    expanded.directedEdges,
    expanded.undirectedEdges,
    expanded.scores
  );

  return {
    subgraph,
    seeds: mergedSeeds.map(s => ({ nodeId: s.nodeId, score: s.score })),
  };
}

// Group seeds by source file, then interleave: take the best seed from each
// source, then the second-best from each, etc., until the cap is hit. This
// prevents a single session from hogging the seed budget when the question
// requires evidence from multiple sessions.
function diversifySeedsBySource(
  seeds: ScoredSeed[],
  graph: KnowledgeGraph,
  cap: number
): ScoredSeed[] {
  if (seeds.length <= cap) return seeds;

  const bySource = new Map<string, ScoredSeed[]>();
  for (const seed of seeds) {
    const node = graph.nodes.get(seed.nodeId);
    const key = node ? node.source.file : '__unknown__';
    const bucket = bySource.get(key);
    if (bucket) bucket.push(seed);
    else bySource.set(key, [seed]);
  }

  const buckets = Array.from(bySource.values()); // Each already ordered by score
  const picked: ScoredSeed[] = [];
  let round = 0;
  while (picked.length < cap) {
    let addedThisRound = false;
    for (const bucket of buckets) {
      if (round < bucket.length) {
        picked.push(bucket[round]);
        addedThisRound = true;
        if (picked.length >= cap) break;
      }
    }
    if (!addedThisRound) break;
    round++;
  }
  return picked;
}

// ---- Date-aware retrieval helpers ----

const DOW_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const NUM_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

interface DateRange {
  start: string; // YYYY-MM-DD inclusive
  end: string; // YYYY-MM-DD inclusive
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Parse an ingest-normalized date string like "2023-05-24 (Wed)" or
// plain "2023-05-24". Returns the YYYY-MM-DD prefix or null.
function isoPrefix(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

// Lightweight temporal-phrase parser. Maps natural-language references
// onto YYYY-MM-DD ranges anchored on `todayIso`. Conservative: returns
// nothing if the question has no detectable temporal phrase, so
// non-temporal questions skip the augmentation entirely.
export function parseTemporalPhrases(question: string, todayIso: string): DateRange[] {
  const q = question.toLowerCase();
  const today = new Date(todayIso + 'T12:00:00Z');
  if (Number.isNaN(today.getTime())) return [];
  const ranges: DateRange[] = [];

  if (/\byesterday\b/.test(q)) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - 1);
    ranges.push({ start: ymd(d), end: ymd(d) });
  }

  // last <day-of-week>
  for (const m of q.matchAll(/\blast (sun|mon|tues?|wed|thur?s?|fri|sat)(?:day|nesday|sday|urday)?\b/g)) {
    const key = m[1].slice(0, 3);
    const target = DOW_NAMES.indexOf(key);
    if (target < 0) continue;
    const todayDow = today.getUTCDay();
    let diff = todayDow - target;
    if (diff <= 0) diff += 7;
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - diff);
    ranges.push({ start: ymd(d), end: ymd(d) });
  }

  // last week (calendar previous week, approx 7-13 days back)
  if (/\blast week\b/.test(q)) {
    const e = new Date(today);
    e.setUTCDate(e.getUTCDate() - 7);
    const s = new Date(today);
    s.setUTCDate(s.getUTCDate() - 13);
    ranges.push({ start: ymd(s), end: ymd(e) });
  }

  // last month (entire previous calendar month)
  if (/\blast month\b/.test(q)) {
    const s = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
    const e = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0));
    ranges.push({ start: ymd(s), end: ymd(e) });
  }

  // N days/weeks/months/years ago, with +/- 1 day buffer
  for (const m of q.matchAll(
    /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(day|week|month|year)s?\s+ago\b/g
  )) {
    const n = NUM_WORDS[m[1]] ?? parseInt(m[1], 10);
    if (!Number.isFinite(n)) continue;
    const d = new Date(today);
    if (m[2] === 'day') d.setUTCDate(d.getUTCDate() - n);
    else if (m[2] === 'week') d.setUTCDate(d.getUTCDate() - n * 7);
    else if (m[2] === 'month') d.setUTCMonth(d.getUTCMonth() - n);
    else if (m[2] === 'year') d.setUTCFullYear(d.getUTCFullYear() - n);
    const s = new Date(d);
    s.setUTCDate(s.getUTCDate() - 1);
    const e = new Date(d);
    e.setUTCDate(e.getUTCDate() + 1);
    ranges.push({ start: ymd(s), end: ymd(e) });
  }

  // in <month> (assume current year, or previous year if month is in the future)
  for (const m of q.matchAll(/\bin (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\b/g)) {
    const monthIdx = MONTH_NAMES.indexOf(m[1]);
    if (monthIdx < 0) continue;
    let year = today.getUTCFullYear();
    if (monthIdx > today.getUTCMonth()) year -= 1;
    const s = new Date(Date.UTC(year, monthIdx, 1));
    const e = new Date(Date.UTC(year, monthIdx + 1, 0));
    ranges.push({ start: ymd(s), end: ymd(e) });
  }

  return ranges;
}

// Pull the top date-matching nodes (by TF-IDF against the question) into
// the seed pool. Defends against the failure mode where TF-IDF concentrates
// all seeds in the wrong-date but topically-similar session and the right
// session never gets a seed.
function augmentSeedsByDate(
  graph: KnowledgeGraph,
  tfidfIndex: TfidfIndex,
  question: string,
  questionDate: string,
  existingSeedMap: Map<string, ScoredSeed>
): ScoredSeed[] {
  const todayIso = isoPrefix(questionDate);
  if (!todayIso) return [];

  const ranges = parseTemporalPhrases(question, todayIso);
  if (ranges.length === 0) return [];

  // Get a wide TF-IDF ranking, then filter to date-matching nodes.
  const wide = findSeeds(question, tfidfIndex, 200);
  const dateMatches: ScoredSeed[] = [];
  for (const seed of wide) {
    if (existingSeedMap.has(seed.nodeId)) continue;
    const node = graph.nodes.get(seed.nodeId);
    if (!node) continue;
    const sd = isoPrefix(typeof node.metadata.sessionDate === 'string' ? node.metadata.sessionDate : null);
    if (!sd) continue;
    if (!ranges.some(r => sd >= r.start && sd <= r.end)) continue;
    dateMatches.push(seed);
    if (dateMatches.length >= 8) break; // bonus seed cap
  }
  return dateMatches;
}

// Walk the retrieved assistant turns and pull in the matching user turn from
// the same session. Conversation chunks carry source.section like
// "Assistant (turn 5)" / "User (turn 5)" (set by conversationToDocument).
// We use a (file, section) index for O(1) lookup of all chunks belonging to
// the partner user turn.
function expandWithSiblingTurns(
  graph: KnowledgeGraph,
  result: ReturnType<typeof traverseGraph>
): ReturnType<typeof traverseGraph> {
  const ASSISTANT_TURN = /^Assistant \(turn (\d+)\)$/;
  const MAX_CHUNKS_PER_TURN = 1; // Take only the first chunk of each user turn
  // Soft total cap: don't let sibling expansion balloon the subgraph past
  // ~1.5x the retrieved size. Multi-session questions regressed in the
  // last smoke when expansion added ~30 user chunks across all assistant
  // anchors and crowded out evidence.
  const MAX_TOTAL_ADDITIONS = Math.max(8, Math.floor(result.nodes.length * 0.5));

  // (file, section) -> nodes for that section. Sections may have multiple
  // chunks if the message was long enough to be split.
  const chunksBySection = new Map<string, GraphNode[]>();
  for (const node of graph.nodes.values()) {
    if (node.type === 'document' || node.type === 'section') continue;
    const section = node.source.section;
    if (!section) continue;
    const key = `${node.source.file}|${section}`;
    const arr = chunksBySection.get(key);
    if (arr) arr.push(node);
    else chunksBySection.set(key, [node]);
  }

  const includedIds = new Set(result.nodes.map(n => n.id));
  const additions: GraphNode[] = [];
  const additionScores = new Map<NodeId, number>();

  // Walk highest-score anchors first so sibling additions favor strong evidence.
  const anchors = [...result.nodes].sort((a, b) => (result.scores.get(b.id) ?? 0) - (result.scores.get(a.id) ?? 0));

  for (const node of anchors) {
    if (additions.length >= MAX_TOTAL_ADDITIONS) break;
    const m = node.source.section?.match(ASSISTANT_TURN);
    if (!m) continue;
    const turnNum = m[1];
    const userKey = `${node.source.file}|User (turn ${turnNum})`;
    const userChunks = chunksBySection.get(userKey);
    if (!userChunks) continue;
    const baseScore = result.scores.get(node.id) ?? 0;
    let addedForThisAnchor = 0;
    for (const userChunk of userChunks) {
      if (addedForThisAnchor >= MAX_CHUNKS_PER_TURN) break;
      if (includedIds.has(userChunk.id)) continue;
      includedIds.add(userChunk.id);
      additions.push(userChunk);
      // Inherit a slightly-lower score so they sort below their assistant
      // anchor in the serialized output but stay above zero.
      additionScores.set(userChunk.id, baseScore * 0.9);
      addedForThisAnchor++;
      if (additions.length >= MAX_TOTAL_ADDITIONS) break;
    }
  }

  if (additions.length === 0) return result;

  const allNodes = [...result.nodes, ...additions];
  const allScores = new Map(result.scores);
  for (const [id, s] of additionScores) allScores.set(id, s);

  // Recompute included edges: any edge whose endpoints are now both selected.
  const idSet = new Set(allNodes.map(n => n.id));
  const directedEdges: DirectedEdge[] = [];
  for (const edge of graph.directedEdges.values()) {
    if (idSet.has(edge.from) && idSet.has(edge.to)) directedEdges.push(edge);
  }
  const undirectedEdges: UndirectedEdge[] = [];
  for (const edge of graph.undirectedEdges.values()) {
    if (idSet.has(edge.nodes[0]) && idSet.has(edge.nodes[1])) undirectedEdges.push(edge);
  }

  return {
    nodes: allNodes,
    directedEdges,
    undirectedEdges,
    scores: allScores,
  };
}

// Enhanced serializer that includes synthesis and context from enrichment
function serializeEnrichedSubgraph(
  nodes: KnowledgeGraph['nodes'] extends Map<string, infer V> ? V[] : never,
  directedEdges: Parameters<typeof serializeSubgraph>[1],
  undirectedEdges: Parameters<typeof serializeSubgraph>[2],
  scores: Parameters<typeof serializeSubgraph>[3]
): SubgraphContext {
  // Use the base serializer first
  const base = serializeSubgraph(nodes, directedEdges, undirectedEdges, scores);

  // Check if any nodes have enrichment data
  const enrichedNodes = nodes.filter(n => n.metadata.synthesis);
  if (enrichedNodes.length === 0) return base;

  // Append enrichment section to the serialized output
  const enrichmentLines: string[] = [];
  enrichmentLines.push('');
  enrichmentLines.push('--- ENRICHED INSIGHTS ---');

  for (const node of enrichedNodes) {
    const score = scores.get(node.id) || 0;
    if (score < 0.1) continue; // Skip low-relevance enriched nodes

    enrichmentLines.push(`[${node.type}|${score.toFixed(2)}] SYNTHESIS: ${node.metadata.synthesis}`);
    if (node.metadata.context) {
      enrichmentLines.push(`  CONTEXT: ${node.metadata.context}`);
    }
  }

  return {
    ...base,
    serialized: base.serialized + '\n' + enrichmentLines.join('\n'),
  };
}

export interface PromptContext {
  // ISO date (YYYY-MM-DD) treated as "today" for the question. When set, the
  // model can compute elapsed time between the question and node session dates.
  questionDate?: string;
}

// Build the system prompt for the LLM with the subgraph context
export function buildGraphPrompt(
  subgraphSerialized: string,
  question: string,
  ctx: PromptContext = {}
): string {
  const dateBlock = ctx.questionDate
    ? `Today's date: ${ctx.questionDate}. Each node may carry a \`date:YYYY-MM-DD (Day)\` tag indicating when the originating session occurred.

When the question references a specific day or relative time (e.g., "last Friday", "yesterday", "three weeks ago", "in March"):
1. First compute the target date(s) from today's date.
2. Then restrict your attention to nodes whose \`date:\` tag matches the target. Treat the day-of-week in the tag as authoritative ("last Friday" must match a node tagged \`(Fri)\` from the prior week, not just any node).
3. Only consider nodes from other dates if no matching node contains the answer.
4. When asked "how many days/weeks/months ago", compute the difference from today's date to the matching node's date.

`
    : '';

  return `You are a knowledge assistant powered by Graphnosis. You answer questions using ONLY the knowledge graph context provided below. If the context doesn't contain enough information, say so explicitly.

${dateBlock}The context is a structured knowledge subgraph with typed nodes and edges:
- Nodes have types: fact, concept, entity, event, definition, claim, data-point, person
- Directed edges show relationships: causes, depends-on, precedes, contains, defines, cites, contradicts, supports, supersedes
- Undirected edges show associations: similar-to, co-occurs, shares-entity, shares-topic, same-source, related-to
- Each node has a relevance score (higher = more relevant to the query)
- Some nodes include SYNTHESIS (a distilled insight) and CONTEXT (how it connects to neighbors)

Use the edge relationships to reason about connections between concepts. Follow directed edges for causal and temporal reasoning. Use undirected edges for context and related information. Prefer synthesized insights when available.

If contradicts edges exist between nodes, acknowledge the conflict and present both sides.

${subgraphSerialized}

Question: ${question}`;
}
