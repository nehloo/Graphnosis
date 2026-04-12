import type { KnowledgeGraph, QueryResult, TfidfIndex, SubgraphContext } from '@/core/types';
import { findSeeds, type ScoredSeed } from './seed-finder';
import { traverseGraph } from './traverser';
import { serializeSubgraph } from './subgraph-serializer';
import { decomposeQuery } from './query-decomposer';
import { buildSynonymMap, expandQuery } from './synonym-expander';

// Enhanced query engine with synonym expansion and query decomposition

export function queryGraph(
  graph: KnowledgeGraph,
  tfidfIndex: TfidfIndex,
  question: string
): Omit<QueryResult, 'answer'> {
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

  const mergedSeeds = Array.from(seedMap.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, 8); // Slightly more seeds than default for better coverage

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
  const traversalResult = traverseGraph(graph, mergedSeeds);

  // Step 5: Serialize with enrichment data (synthesis + context) if available
  const subgraph = serializeEnrichedSubgraph(
    traversalResult.nodes,
    traversalResult.directedEdges,
    traversalResult.undirectedEdges,
    traversalResult.scores
  );

  return {
    subgraph,
    seeds: mergedSeeds.map(s => ({ nodeId: s.nodeId, score: s.score })),
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

// Build the system prompt for the LLM with the subgraph context
export function buildGraphPrompt(subgraphSerialized: string, question: string): string {
  return `You are a knowledge assistant powered by graphAI. You answer questions using ONLY the knowledge graph context provided below. If the context doesn't contain enough information, say so explicitly.

The context is a structured knowledge subgraph with typed nodes and edges:
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
