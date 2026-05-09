// Embedding-index data structure + helpers, parameterized over an
// `EmbeddingAdapter`. The adapter handles the actual provider call
// (OpenAI, Voyage, Cohere, custom); this module just owns the in-memory
// index and the batched-with-progress wiring.
//
// `ai` and `@ai-sdk/openai` are NO LONGER referenced from this file.
// Provider-specific code lives under `src/sdk/adapters/`. Consumers who
// want OpenAI behavior import `openaiEmbedAdapter` from
// `@nehloo/graphnosis/adapters/openai`.

import type { NodeId, IndexProvenance } from '@/core/types';
import type { EmbeddingAdapter } from './embedding-adapter';

export type EmbeddingVector = number[];

export interface EmbeddingIndex {
  /** nodeId → embedding vector. Vectors are L2-normalized by the adapter. */
  vectors: Map<NodeId, EmbeddingVector>;
  /** Vector dimensionality. Set on first add. */
  dimensions: number;
  /** Index provenance (adapter id, createdAt, optional staleness checksum). */
  provenance: IndexProvenance;
}

export interface EmbedOptions {
  /**
   * Intent for the input texts. Forwarded to `adapter.embed()`.
   * Defaults to `'document'` (build-time). `queryHybrid` / `promptHybrid`
   * pass `'query'`.
   */
  intent?: 'document' | 'query';
  /**
   * Batch size for adapter calls. The adapter is free to chunk further
   * internally, but smaller batches give us a natural granularity for
   * `onProgress` callbacks and easier cancellation.
   */
  batchSize?: number;
  /** Called after each batch finishes. Useful for long ingest passes. */
  onProgress?: (info: { done: number; total: number }) => void;
  /** Forwarded to `adapter.embed(..., signal)`. */
  signal?: AbortSignal;
}

export function createEmbeddingIndex(adapter: EmbeddingAdapter): EmbeddingIndex {
  return {
    vectors: new Map(),
    dimensions: adapter.dimensions,
    provenance: {
      adapterId: adapter.id,
      createdAt: Date.now(),
    },
  };
}

/**
 * Embed a batch of `(nodeId, text)` pairs and write into the index.
 * Empty / whitespace-only texts are skipped (most providers reject them).
 */
export async function embedNodes(
  index: EmbeddingIndex,
  adapter: EmbeddingAdapter,
  items: Array<{ nodeId: NodeId; text: string }>,
  opts: EmbedOptions = {}
): Promise<void> {
  const valid = items.filter(item => item.text.trim().length > 0);
  if (valid.length === 0) return;

  const batchSize = Math.max(1, opts.batchSize ?? 256);
  const intent = opts.intent ?? 'document';

  let done = 0;
  for (let start = 0; start < valid.length; start += batchSize) {
    const slice = valid.slice(start, start + batchSize);
    const vectors = await adapter.embed(slice.map(v => v.text), intent, opts.signal);

    if (vectors.length !== slice.length) {
      throw new Error(
        `[graphnosis] embedding adapter '${adapter.id}' returned ${vectors.length} vectors for ${slice.length} inputs (must match)`
      );
    }

    for (let i = 0; i < slice.length; i++) {
      const vec = vectors[i];
      if (!vec) continue;
      index.vectors.set(slice[i].nodeId, vec);
      if (index.dimensions === 0) index.dimensions = vec.length;
    }

    done += slice.length;
    opts.onProgress?.({ done, total: valid.length });
  }
}

/** Embed a single query string. Returns null on empty input. */
export async function embedQuery(
  adapter: EmbeddingAdapter,
  query: string,
  opts: { signal?: AbortSignal } = {}
): Promise<EmbeddingVector | null> {
  const text = query.trim();
  if (!text) return null;
  const vectors = await adapter.embed([text], 'query', opts.signal);
  return vectors[0] ?? null;
}
