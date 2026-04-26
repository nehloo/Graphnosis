import { nanoid } from 'nanoid';
import type { UndirectedEdge, UndirectedEdgeType, ExtractedChunk, TfidfIndex, NodeId } from '@/core/types';
import { SIMILARITY_THRESHOLD, ENTITY_JACCARD_THRESHOLD } from '@/core/constants';
import { getTfidfVector, tokenizeWith } from '@/core/similarity/tfidf';
import { cosineSimilarity } from '@/core/similarity/cosine';
import { jaccardSimilarity } from '@/core/similarity/jaccard';
import { asciiFoldAnalyzer, type TextAnalyzer } from '@/core/similarity/analyzer';
import { chunkKey } from './directed-edges';

const MAX_SIMILARITY_CANDIDATES = 50; // Max candidates per node to check similarity against
const MAX_EDGES_PER_NODE = 10; // Cap edges per node to avoid explosion

export function buildUndirectedEdges(
  chunks: ExtractedChunk[],
  tfidfIndex: TfidfIndex,
  nodeIdMap: Map<string, NodeId>,
  analyzer: TextAnalyzer = asciiFoldAnalyzer
): UndirectedEdge[] {
  const edges: UndirectedEdge[] = [];
  const seen = new Set<string>();
  const edgeCountPerNode = new Map<NodeId, number>();

  // Only compare content chunks (skip document/section structural nodes)
  const contentChunks = chunks.filter(c => c.type !== 'document' && c.type !== 'section');

  // Build inverted index: term → list of chunk indices (for fast candidate lookup)
  const termIndex = new Map<string, number[]>();
  for (let i = 0; i < contentChunks.length; i++) {
    const tokens = tokenizeWith(analyzer, contentChunks[i].content);
    const uniqueTokens = new Set(tokens);
    for (const token of uniqueTokens) {
      const list = termIndex.get(token) || [];
      list.push(i);
      termIndex.set(token, list);
    }
  }

  // 1. Similarity edges: only compare chunks that share at least one term
  for (let i = 0; i < contentChunks.length; i++) {
    const chunkA = contentChunks[i];
    const keyA = chunkKey(chunkA);
    const nodeIdA = nodeIdMap.get(keyA);
    if (!nodeIdA) continue;

    // Find candidate chunks that share terms with chunk A
    const candidateSet = new Set<number>();
    const tokensA = tokenizeWith(analyzer, chunkA.content);
    for (const token of new Set(tokensA)) {
      const list = termIndex.get(token);
      if (list && list.length < 500) { // Skip very common terms
        for (const j of list) {
          if (j > i) candidateSet.add(j);
        }
      }
    }

    // Limit candidates
    const candidates = Array.from(candidateSet).slice(0, MAX_SIMILARITY_CANDIDATES);

    for (const j of candidates) {
      const chunkB = contentChunks[j];
      const keyB = chunkKey(chunkB);
      const nodeIdB = nodeIdMap.get(keyB);
      if (!nodeIdB) continue;

      // Check edge count cap
      if ((edgeCountPerNode.get(nodeIdA) || 0) >= MAX_EDGES_PER_NODE) break;
      if ((edgeCountPerNode.get(nodeIdB) || 0) >= MAX_EDGES_PER_NODE) continue;

      const pairKey = nodeIdA < nodeIdB ? `${nodeIdA}:${nodeIdB}` : `${nodeIdB}:${nodeIdA}`;
      if (seen.has(pairKey)) continue;

      // TF-IDF cosine similarity
      const vecA = getTfidfVector(tfidfIndex, nodeIdA);
      const vecB = getTfidfVector(tfidfIndex, nodeIdB);
      const cosine = cosineSimilarity(vecA, vecB);

      if (cosine >= SIMILARITY_THRESHOLD) {
        edges.push(createEdge(nodeIdA, nodeIdB, 'similar-to', cosine));
        seen.add(pairKey);
        edgeCountPerNode.set(nodeIdA, (edgeCountPerNode.get(nodeIdA) || 0) + 1);
        edgeCountPerNode.set(nodeIdB, (edgeCountPerNode.get(nodeIdB) || 0) + 1);
        continue; // Don't add duplicate edges for same pair
      }

      // Entity overlap
      if (chunkA.entities.length > 0 && chunkB.entities.length > 0) {
        const jaccard = jaccardSimilarity(chunkA.entities, chunkB.entities);
        if (jaccard >= ENTITY_JACCARD_THRESHOLD) {
          edges.push(createEdge(nodeIdA, nodeIdB, 'shares-entity', jaccard));
          seen.add(pairKey);
          edgeCountPerNode.set(nodeIdA, (edgeCountPerNode.get(nodeIdA) || 0) + 1);
          edgeCountPerNode.set(nodeIdB, (edgeCountPerNode.get(nodeIdB) || 0) + 1);
        }
      }
    }
  }

  // 2. Co-occurrence edges: chunks in the same section (limited to nearby chunks)
  const sectionChunks = new Map<string, ExtractedChunk[]>();
  for (const chunk of contentChunks) {
    const sectionKey = `${chunk.source.file}:${chunk.source.section || 'root'}`;
    const group = sectionChunks.get(sectionKey) || [];
    group.push(chunk);
    sectionChunks.set(sectionKey, group);
  }

  for (const group of sectionChunks.values()) {
    // Only connect nearby chunks in the same section (window of 3)
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < Math.min(i + 4, group.length); j++) {
        const nodeIdA = nodeIdMap.get(chunkKey(group[i]));
        const nodeIdB = nodeIdMap.get(chunkKey(group[j]));
        if (!nodeIdA || !nodeIdB) continue;

        const pairKey = nodeIdA < nodeIdB ? `${nodeIdA}:${nodeIdB}` : `${nodeIdB}:${nodeIdA}`;
        if (seen.has(pairKey)) continue;

        edges.push(createEdge(nodeIdA, nodeIdB, 'co-occurs', 0.4));
        seen.add(pairKey);
      }
    }
  }

  return edges;
}

function createEdge(nodeA: NodeId, nodeB: NodeId, type: UndirectedEdgeType, weight: number): UndirectedEdge {
  return {
    id: nanoid(),
    nodes: [nodeA, nodeB],
    type,
    weight,
  };
}
