// Semantic embeddings via OpenAI (text-embedding-3-small by default).
// Used as an opt-in replacement for TF-IDF in seed-finding so retrieval can
// match by meaning ("work history", "previous job") rather than literal terms.
//
// Stays out of the core ingestion path unless explicitly enabled — the app
// (Chat / Giki / etc.) keeps working without an embedding API call per ingest.
//
// `ai` and `@ai-sdk/openai` are PEER dependencies — the consumer must install
// them. They are loaded lazily here so the package can be imported without
// error by consumers who never call the embedding functions.

import type { NodeId } from '@/core/types';

export type EmbeddingVector = number[];

export interface EmbeddingIndex {
  // nodeId -> embedding vector. Vectors are L2-normalized so cosine similarity
  // collapses to a dot product (the AI SDK's `cosineSimilarity` does the math
  // either way; normalization here just keeps the index compact and stable).
  vectors: Map<NodeId, EmbeddingVector>;
  model: string;
  dimensions: number;
}

export interface EmbedOptions {
  model?: string; // e.g. 'text-embedding-3-small' (default) or 'text-embedding-3-large'
  // Batch size for `embedMany`. The AI SDK already chunks internally, but
  // smaller batches are easier to retry on transient failures.
  batchSize?: number;
}

const DEFAULT_MODEL = 'text-embedding-3-small';

const PEER_DEP_HINT =
  'Install the peer dependencies to use embedding features:\n' +
  '  npm install ai @ai-sdk/openai';

async function loadAiSdk(): Promise<{
  embedMany: typeof import('ai')['embedMany'];
  cosineSimilarity: typeof import('ai')['cosineSimilarity'];
  openai: typeof import('@ai-sdk/openai')['openai'];
}> {
  try {
    const [aiMod, openaiMod] = await Promise.all([
      import('ai'),
      import('@ai-sdk/openai'),
    ]);
    return { embedMany: aiMod.embedMany, cosineSimilarity: aiMod.cosineSimilarity, openai: openaiMod.openai };
  } catch {
    throw new Error(
      `@nehloo/graphnosis: embedding functions require peer dependencies that are not installed.\n${PEER_DEP_HINT}`
    );
  }
}

export function createEmbeddingIndex(model: string = DEFAULT_MODEL): EmbeddingIndex {
  return { vectors: new Map(), model, dimensions: 0 };
}

// Embed a batch of (nodeId, text) pairs and write into the index.
// Empty / whitespace-only texts are skipped (the API rejects them anyway).
export async function embedNodes(
  index: EmbeddingIndex,
  items: Array<{ nodeId: NodeId; text: string }>,
  opts: EmbedOptions = {}
): Promise<void> {
  const valid = items.filter(item => item.text.trim().length > 0);
  if (valid.length === 0) return;

  const { embedMany, openai } = await loadAiSdk();
  const model = opts.model ?? index.model ?? DEFAULT_MODEL;

  const { embeddings } = await embedMany({
    model: openai.embedding(model),
    values: valid.map(v => v.text),
    // LongMemEval haystacks burst ~100K tokens per question. With even modest
    // parallelism the OpenAI 1M TPM window fills before retries can recover.
    // Bump well above the SDK default (2) so the rate-limit error surfaces
    // only on prolonged contention, not transient bursts.
    maxRetries: 10,
  });

  for (let i = 0; i < valid.length; i++) {
    const vec = embeddings[i];
    if (!vec) continue;
    index.vectors.set(valid[i].nodeId, vec);
    if (index.dimensions === 0) index.dimensions = vec.length;
  }
}

// Embed a single query string. Returns null on empty input.
export async function embedQuery(
  query: string,
  opts: EmbedOptions = {}
): Promise<EmbeddingVector | null> {
  const text = query.trim();
  if (!text) return null;
  const { embedMany, openai } = await loadAiSdk();
  const model = opts.model ?? DEFAULT_MODEL;
  const { embeddings } = await embedMany({
    model: openai.embedding(model),
    values: [text],
    maxRetries: 10,
  });
  return embeddings[0] ?? null;
}

// Re-export cosineSimilarity lazily so callers don't need to depend on `ai` directly.
export async function getCosineSimilarity(): Promise<typeof import('ai')['cosineSimilarity']> {
  const { cosineSimilarity } = await loadAiSdk();
  return cosineSimilarity;
}
