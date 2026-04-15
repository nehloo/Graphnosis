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

  for (const node of result.nodes) {
    const m = node.source.section?.match(ASSISTANT_TURN);
    if (!m) continue;
    const turnNum = m[1];
    const userKey = `${node.source.file}|User (turn ${turnNum})`;
    const userChunks = chunksBySection.get(userKey);
    if (!userChunks) continue;
    const baseScore = result.scores.get(node.id) ?? 0;
    for (const userChunk of userChunks) {
      if (includedIds.has(userChunk.id)) continue;
      includedIds.add(userChunk.id);
      additions.push(userChunk);
      // Inherit a slightly-lower score so they sort below their assistant
      // anchor in the serialized output but stay above zero.
      additionScores.set(userChunk.id, baseScore * 0.9);
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
