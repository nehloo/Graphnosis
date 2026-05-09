import type {
  KnowledgeGraph,
  QueryResult,
  TfidfIndex,
  SubgraphContext,
  GraphNode,
  DirectedEdge,
  DirectedEdgeType,
  UndirectedEdge,
  NodeId,
} from '@/core/types';
import { findSeeds, findSeedsByEmbedding, type ScoredSeed } from './seed-finder';
import { traverseGraph } from './traverser';
import { serializeSubgraph } from './subgraph-serializer';
import { decomposeQuery } from './query-decomposer';
import { buildSynonymMap, expandQuery } from './synonym-expander';
import type { EmbeddingIndex, EmbeddingVector } from '@/core/similarity/embeddings';
import {
  classifyQuestion,
  getRetrievalStrategy,
  buildCategoryPromptBlock,
  type RouterDecision,
} from './router';
import type { LMEQuestionType } from '@/core/types';

// Enhanced query engine with synonym expansion and query decomposition

export interface QueryOptions {
  maxNodes?: number; // Override the default subgraph size cap
  maxSeeds?: number; // Cap on merged seeds after sub-query expansion (default 24)
  diversify?: boolean; // Round-robin seeds across source files to cover multi-session questions (default true)
  // Semantic-retrieval mode. When both are provided, embedding seeds are
  // merged into the seed pool alongside TF-IDF seeds. This lets us match
  // "previous job" against a session that says "Acme Corp" without sharing
  // any literal terms.
  embeddingIndex?: EmbeddingIndex;
  queryEmbedding?: EmbeddingVector;
  // When true, skip the TF-IDF seed pool entirely and use only embedding
  // seeds. Has no effect unless embeddingIndex + queryEmbedding are set.
  embeddingsOnly?: boolean;
  // Phase 1 router hook: when a category is supplied (either via regex
  // classification at call time or as ground-truth for ablation runs), the
  // router drives defaults for maxSeeds / maxNodes / diversify. Explicit
  // opts still override so the CLI --max-nodes flag keeps working.
  questionType?: LMEQuestionType;
  // When true, the router runs classifyQuestion on the question text and
  // uses the returned category as if it had been passed explicitly. When
  // false (the default), we preserve pre-router behavior exactly (legacy
  // regex-inline branching). This is the single flag threaded from the CLI
  // to A/B-test Phase 1 cleanly against Run 14.
  useRouter?: boolean;
}

export function queryGraph(
  graph: KnowledgeGraph,
  tfidfIndex: TfidfIndex,
  question: string,
  opts: QueryOptions = {}
): Omit<QueryResult, 'answer'> & { router?: RouterDecision } {
  // Router dispatch (Phase 1). Either the caller supplied a category
  // explicitly (e.g. ablation with ground-truth `question_type`) or the
  // `--enable-router` flag has flipped `useRouter` on so we classify from
  // the question text. Everything else falls back to the pre-router path
  // below — this keeps Run 14's behavior byte-for-byte reproducible.
  let router: RouterDecision | undefined;
  if (opts.questionType) {
    router = {
      category: opts.questionType,
      strategy: getRetrievalStrategy(opts.questionType),
      source: 'explicit',
    };
  } else if (opts.useRouter) {
    const category = classifyQuestion(question);
    router = { category, strategy: getRetrievalStrategy(category), source: 'regex' };
  }

  // Aggregation questions (count / sum / total) need more evidence than
  // standard questions - their failure mode is missing ONE session among
  // several. Widen both the seed pool and the node budget when detected,
  // unless the caller has explicitly overridden. When the router has
  // produced a decision, it supersedes this legacy detection.
  const isAggregation = !router && isAggregationQuestion(question);
  const maxSeeds =
    opts.maxSeeds ?? (router ? router.strategy.maxSeeds : isAggregation ? 40 : 24);
  const maxNodes =
    opts.maxNodes ?? (router ? router.strategy.maxNodes : isAggregation ? 50 : undefined);
  const diversify =
    opts.diversify ?? (router ? router.strategy.diversifyByFile : true);

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

  const useEmbeddings = !!(opts.embeddingIndex && opts.queryEmbedding);
  const skipTfidf = useEmbeddings && opts.embeddingsOnly === true;

  // Phase 2 seed policy: only propagate preferSummarySeeds to the seed
  // finder when the router has actually run. In legacy mode we leave it
  // undefined so summary nodes (if present) are treated like any other
  // seed — preserves Run 14 parity.
  const seedOpts = router
    ? { graph, preferSummarySeeds: router.strategy.preferSummarySeeds }
    : undefined;

  // Step 3: Find seeds across all query variants and merge (TF-IDF pool)
  const seedMap = new Map<string, ScoredSeed>();
  if (!skipTfidf) {
    for (const q of uniqueQueries) {
      const seeds = findSeeds(q, tfidfIndex, undefined, seedOpts);
      for (const seed of seeds) {
        const existing = seedMap.get(seed.nodeId);
        if (!existing || seed.score > existing.score) {
          seedMap.set(seed.nodeId, seed);
        }
      }
    }
  }

  // Step 3b: Embedding-based seed pool. In hybrid mode (the default when an
  // embedding index is provided) these are merged with TF-IDF seeds; in
  // embeddings-only mode they are the entire pool. The query was pre-embedded
  // by the caller (one API call) so this stage is pure linear-algebra over
  // the in-memory EmbeddingIndex. Use a generous bonus cap so semantic
  // matches have room to compete; diversification + BFS budget trim the pool.
  if (useEmbeddings) {
    const embedCap = skipTfidf ? maxSeeds * 2 : 16;
    const embedSeeds = findSeedsByEmbedding(
      opts.queryEmbedding!,
      opts.embeddingIndex!,
      embedCap,
      undefined,
      seedOpts
    );
    for (const seed of embedSeeds) {
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
      router,
    };
  }

  // Phase 2: for targeted single-session questions, block the 'summarizes'
  // edge so a summary node (should one slip into the seed pool via term
  // overlap) can't drag every turn of its session into the subgraph.
  const blockedEdgeTypes = routerBlockedEdges(router?.category);

  // Step 4: Traverse graph from merged seeds
  const traversalResult = traverseGraph(graph, mergedSeeds, undefined, maxNodes, {
    blockedEdgeTypes,
  });

  // Step 4a: Summary-child down-weight. When a summary node is in the
  // retrieved set, its turn-level children would otherwise score highly
  // via the 'summarizes' edge and end up duplicating what the summary
  // already says. Halve their scores so they sort below novel evidence
  // from other sessions.
  downweightSummaryChildren(graph, traversalResult);

  // Step 4b: Sibling-turn expansion. For each retrieved Assistant chunk,
  // also include the User chunk(s) from the same turn pair. User questions
  // routinely carry the key fact ("I bought X yesterday") but lose the
  // TF-IDF battle to longer assistant responses, so they get evicted from
  // the seed pool. Without them the model has no grounding for "what did I
  // X" questions even when the right session is retrieved.
  const expanded = expandWithSiblingTurns(graph, traversalResult);

  // Step 4c: Semantic reranking. When we have the query embedding, blend
  // cosine similarity with traversal score so the prompt surfaces the most
  // meaning-relevant nodes at the top. Traversal alone rewards graph-structure
  // proximity to the seeds, which is valuable but can leave tangential nodes
  // outranking the ones that actually answer the question.
  if (useEmbeddings) {
    rerankByEmbedding(expanded, opts.embeddingIndex!, opts.queryEmbedding!);
  }

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
    router,
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

// Blend embedding similarity with the existing traversal score so the final
// serialized subgraph ranks by "meaning relevance + structural relevance".
// Mutates `result.scores` in place. Does not change the node set, only the
// scores used by the serializer to sort.
function rerankByEmbedding(
  result: ReturnType<typeof traverseGraph>,
  embeddingIndex: EmbeddingIndex,
  queryVec: EmbeddingVector
): void {
  // Compute embedding similarity for each node. Keep track of max traversal
  // score so we can normalize the two signals onto the same scale before
  // blending - traversal scores vary (seed × decay^hop) while cosine is in
  // [0, 1].
  let maxTraversal = 0;
  for (const s of result.scores.values()) if (s > maxTraversal) maxTraversal = s;
  if (maxTraversal === 0) return;

  for (const node of result.nodes) {
    const emb = embeddingIndex.vectors.get(node.id);
    const traversal = result.scores.get(node.id) ?? 0;
    if (!emb) {
      result.scores.set(node.id, traversal / maxTraversal); // just normalize
      continue;
    }
    const semantic = Math.max(0, cosineSimilarityVec(queryVec, emb));
    // 50/50 blend. Could be tuned per category; uniform is a safe starting
    // point and avoided over-fitting on the hybrid smoke.
    result.scores.set(node.id, 0.5 * (traversal / maxTraversal) + 0.5 * semantic);
  }
}

// Dot-product cosine over two equal-length vectors. Duplicates the ai-sdk
// helper locally so this module stays self-contained for testing.
function cosineSimilarityVec(a: EmbeddingVector, b: EmbeddingVector): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Phase 2 router policy: single-session-user / -assistant questions want
// tight, turn-level recall. Block the 'summarizes' edge for those so BFS
// can't pull an entire session in via a summary seed.
function routerBlockedEdges(
  category: LMEQuestionType | undefined
): Set<DirectedEdgeType> | undefined {
  if (category === 'single-session-user' || category === 'single-session-assistant') {
    return new Set<DirectedEdgeType>(['summarizes']);
  }
  return undefined;
}

// When a summary node survived traversal, halve the scores of its child
// turn nodes so the prompt isn't filled with fact-duplicated material.
// Mutates result.scores in place. Safe no-op when there are no summary
// nodes in the retrieved set.
function downweightSummaryChildren(
  graph: KnowledgeGraph,
  result: ReturnType<typeof traverseGraph>
): void {
  const includedIds = new Set(result.nodes.map(n => n.id));
  const summaryIds = new Set<NodeId>();
  for (const node of result.nodes) {
    if (node.type === 'session-summary') summaryIds.add(node.id);
  }
  if (summaryIds.size === 0) return;

  for (const edge of graph.directedEdges.values()) {
    if (edge.type !== 'summarizes') continue;
    if (!summaryIds.has(edge.from)) continue;
    if (!includedIds.has(edge.to)) continue;
    const current = result.scores.get(edge.to) ?? 0;
    result.scores.set(edge.to, current * 0.5);
  }
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
  // Phase 1 router hook. When a category is supplied, buildGraphPrompt uses
  // the router's category-specific prompt block and skips the legacy
  // regex-inline branching entirely. Left undefined for pre-router callers.
  questionType?: LMEQuestionType;
}

// Heuristic: does this look like a question about the user's preferences,
// habits, or personal choices? Preference questions are scored by the judge
// against a rubric ("recalls and utilizes personal information correctly"),
// not a single gold answer - they need the model to ground in User turns
// (where the user stated things about themselves) rather than Assistant
// generalities. Detected here so we can nudge the prompt without requiring
// callers to tag question_type.
const PREFERENCE_INTENT =
  /\b(favorite|favourite|prefer|preference|usually|typically|habit|routine|tend to|like to|love to|hate|enjoy|style|personal)\b/i;

function isPreferenceQuestion(question: string): boolean {
  return PREFERENCE_INTENT.test(question);
}

// Heuristic: aggregation question (count / sum / total). Failure mode for
// these is retrieval-completeness - we surface most relevant sessions but
// miss one, so the aggregate comes out low. When detected we widen both
// the seed pool and the final subgraph budget, and add a prompt block that
// tells the model to enumerate-then-compute and to verify each instance
// matches the question's criterion (e.g. "cuisine" excludes "vegan diet").
const AGGREGATION_INTENT =
  /\b(total|how many|how much|number of|count of|sum of|all of the|every time)\b/i;

export function isAggregationQuestion(question: string): boolean {
  return AGGREGATION_INTENT.test(question);
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

  // When the router has supplied a category, use the single category-specific
  // block from router.buildCategoryPromptBlock. Otherwise fall back to the
  // legacy inline regex-detected blocks (Run 14 behavior) for exact
  // A/B comparability.
  let categoryBlock: string;
  if (ctx.questionType) {
    categoryBlock = buildCategoryPromptBlock(ctx.questionType);
  } else {
    const preferenceBlock = isPreferenceQuestion(question)
      ? `This question asks about the user's preferences, habits, or personal choices. Ground your answer in statements the user explicitly made about themselves — prioritize nodes tagged \`src:User (turn N)\`. When multiple user statements are consistent, synthesize them; when they conflict, prefer the most recent (highest date).

`
      : '';

    const aggregationBlock = isAggregationQuestion(question)
      ? `This question asks for a total, count, or aggregate across multiple sessions. Procedure:
1. Start with the SESSION SUMMARIES block. Each summary may have a \`claims:\` line — these are atomic, countable facts in the user's own voice (e.g. "I bought 30 lbs of coffee beans"). Use them as your primary counting evidence before turning to raw turn nodes.
2. Scan the context and list each instance that matches the question's criterion (e.g., "cuisine" = a national/regional cooking tradition, NOT a diet like "vegan"; "purchase" = an actual buy event, NOT a wish).
3. For each candidate, verify it actually matches — reject loose matches.
4. Distinguish between ADDITIONS and SUPERSEDED totals:
   - If two sessions describe separate events that each add to the total ("I bought 30 lbs" then "I bought 40 lbs"), SUM them.
   - If a later session restates the running total ("I've now collected 25 in total", "my count is up to 12"), USE the most recent stated total — do NOT add it to earlier partial counts.
5. Compute the aggregate.
6. State the answer first, then briefly list the instances you counted (citing session date or ID when available).
If you found fewer instances than expected, don't inflate the count — report only what's in the context.

`
      : '';
    categoryBlock = preferenceBlock + aggregationBlock;
  }

  return `You are a knowledge assistant powered by Graphnosis. You answer questions using ONLY the knowledge graph context provided below. If the context doesn't contain enough information, say so explicitly.

Answer concisely. Lead with the direct answer in the first sentence, then cite supporting detail only if useful. Avoid padding or unrelated context — extra information that conflicts with the answer counts against you.

${dateBlock}${categoryBlock}The context is a structured knowledge subgraph with typed nodes and edges:
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
