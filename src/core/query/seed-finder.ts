import type { KnowledgeGraph, NodeId, TfidfIndex } from '@/core/types';
import { SEED_COUNT } from '@/core/constants';
import { queryVector, getTfidfVector } from '@/core/similarity/tfidf';
import { cosineSimilarity } from '@/core/similarity/cosine';
import type { EmbeddingIndex, EmbeddingVector } from '@/core/similarity/embeddings';
// Local dot-product cosine for float vectors (number[]) — avoids pulling in
// the `ai` peer dependency just for this math.
function floatCosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

export interface ScoredSeed {
  nodeId: NodeId;
  score: number;
}

// Phase 2: routing knob. When true, session-summary nodes get a 1.3×
// score boost (pulls the session index into the seed pool for
// multi-session / temporal / knowledge-update questions). When false,
// summary nodes are excluded from the seed pool entirely so targeted
// single-session questions aren't diluted by a coarse summary. Default
// (undefined) preserves Run 14 behavior: summaries neither boosted nor
// filtered.
export interface SeedOptions {
  graph?: KnowledgeGraph;
  preferSummarySeeds?: boolean;
}

const SUMMARY_SEED_BOOST = 1.3;

function adjustForSummaries(
  scores: ScoredSeed[],
  opts: SeedOptions | undefined
): ScoredSeed[] {
  if (!opts?.graph) return scores;
  const graph = opts.graph;

  if (opts.preferSummarySeeds === true) {
    return scores.map(s => {
      const node = graph.nodes.get(s.nodeId);
      if (node?.type === 'session-summary') {
        return { nodeId: s.nodeId, score: s.score * SUMMARY_SEED_BOOST };
      }
      return s;
    });
  }

  if (opts.preferSummarySeeds === false) {
    return scores.filter(s => {
      const node = graph.nodes.get(s.nodeId);
      return node?.type !== 'session-summary';
    });
  }

  return scores;
}

export function findSeeds(
  query: string,
  tfidfIndex: TfidfIndex,
  maxSeeds: number = SEED_COUNT,
  opts?: SeedOptions
): ScoredSeed[] {
  const qVec = queryVector(tfidfIndex, query);
  if (qVec.size === 0) return [];

  const scores: ScoredSeed[] = [];

  for (const nodeId of tfidfIndex.documents.keys()) {
    const nodeVec = getTfidfVector(tfidfIndex, nodeId);
    const score = cosineSimilarity(qVec, nodeVec);
    if (score > 0) {
      scores.push({ nodeId, score });
    }
  }

  // Sort by score descending and take top K, after applying the
  // summary-seed policy so boosted summaries can actually win a slot.
  const adjusted = adjustForSummaries(scores, opts);
  adjusted.sort((a, b) => b.score - a.score);
  return adjusted.slice(0, maxSeeds);
}

// Embedding-based variant. Caller pre-embeds the query (one API call) and
// passes the vector in; we just rank nodes by cosine similarity. Used when
// the literal-term overlap of TF-IDF misses semantically-related sessions
// ("work history" vs "previous job at Acme").
export function findSeedsByEmbedding(
  queryVec: EmbeddingVector,
  embeddingIndex: EmbeddingIndex,
  maxSeeds: number = SEED_COUNT,
  minScore: number = 0.2,
  opts?: SeedOptions
): ScoredSeed[] {
  const scores: ScoredSeed[] = [];
  for (const [nodeId, vec] of embeddingIndex.vectors) {
    const score = floatCosine(queryVec, vec);
    if (score >= minScore) scores.push({ nodeId, score });
  }
  const adjusted = adjustForSummaries(scores, opts);
  adjusted.sort((a, b) => b.score - a.score);
  return adjusted.slice(0, maxSeeds);
}
