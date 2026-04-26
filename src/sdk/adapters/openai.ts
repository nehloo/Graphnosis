// OpenAI embedding adapter. Wraps `@ai-sdk/openai` + `ai` (peer deps,
// loaded lazily). Symmetric model — `intent` is ignored; the same vector
// space is used for both 'document' and 'query' inputs.
//
// This is the v0.2 home for the OpenAI integration that v0.1.5 baked
// into the core embeddings module. Consumers who don't need OpenAI
// shouldn't import this module — that keeps the peer deps optional in
// practice (not just in package.json).

import type { EmbeddingAdapter } from '@/core/similarity/embedding-adapter';

const PEER_DEP_HINT =
  'Install the peer dependencies to use the OpenAI embedding adapter:\n' +
  '  npm install ai @ai-sdk/openai';

async function loadAiSdk(): Promise<{
  embedMany: typeof import('ai')['embedMany'];
  openai: typeof import('@ai-sdk/openai')['openai'];
}> {
  try {
    const [aiMod, openaiMod] = await Promise.all([
      import('ai'),
      import('@ai-sdk/openai'),
    ]);
    return { embedMany: aiMod.embedMany, openai: openaiMod.openai };
  } catch {
    throw new Error(`[graphnosis] ${PEER_DEP_HINT}`);
  }
}

export interface OpenAIEmbedAdapterOptions {
  /**
   * Model id. Default `'text-embedding-3-small'`. Pass `'text-embedding-3-large'`
   * for higher quality (3072 dims, ~5x cost).
   */
  model?: string;
  /**
   * Output dimensionality. Required because the adapter's `id` encodes
   * it — and OpenAI lets you request smaller dimensions for the
   * `-3-*` models. Defaults match each model's native output:
   *   text-embedding-3-small → 1536
   *   text-embedding-3-large → 3072
   *   text-embedding-ada-002 → 1536
   */
  dimensions?: number;
  /**
   * Max retries on transient errors (rate limits, network). Default 10 —
   * the AI SDK's default of 2 is too low for LongMemEval-scale workloads
   * where the OpenAI 1M TPM window fills before the SDK gives up.
   */
  maxRetries?: number;
}

const DEFAULT_DIMENSIONS: Record<string, number> = {
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'text-embedding-ada-002': 1536,
};

export function openaiEmbedAdapter(opts: OpenAIEmbedAdapterOptions = {}): EmbeddingAdapter {
  const model = opts.model ?? 'text-embedding-3-small';
  const dimensions = opts.dimensions ?? DEFAULT_DIMENSIONS[model] ?? 1536;
  const maxRetries = opts.maxRetries ?? 10;

  return {
    id: `openai:${model}@${dimensions}`,
    dimensions,
    async embed(texts: string[], _intent?: 'document' | 'query', signal?: AbortSignal): Promise<number[][]> {
      // OpenAI embedding models are symmetric — `intent` is intentionally
      // ignored. Voyage / Cohere adapters MUST honor it.
      void _intent;
      if (texts.length === 0) return [];
      const { embedMany, openai } = await loadAiSdk();
      const { embeddings } = await embedMany({
        model: openai.embedding(model),
        values: texts,
        maxRetries,
        abortSignal: signal,
      });
      return embeddings;
    },
  };
}
