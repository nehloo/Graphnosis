// Static embedding adapter — for tests, offline benchmarks, and
// deterministic CI runs. Looks up vectors in a `Map<text, vector>`;
// throws on miss. No network, no peer deps.

import type { EmbeddingAdapter } from '@/core/similarity/embedding-adapter';

export interface StaticEmbedAdapterOptions {
  /** id for provenance. Defaults to `'static@<dimensions>'`. */
  id?: string;
  /** Map from input text to its pre-computed vector. */
  vectors: Map<string, number[]> | Record<string, number[]>;
  /**
   * Vector dimensionality. If omitted, inferred from the first vector
   * in the map.
   */
  dimensions?: number;
  /**
   * Behavior on lookup miss. `'throw'` (default) makes test failures
   * loud. `'zeros'` returns a zero-vector — useful for benchmark
   * stress tests where missing entries shouldn't crash.
   */
  onMiss?: 'throw' | 'zeros';
}

export function staticEmbedAdapter(opts: StaticEmbedAdapterOptions): EmbeddingAdapter {
  const map = opts.vectors instanceof Map
    ? opts.vectors
    : new Map(Object.entries(opts.vectors));

  let dims = opts.dimensions;
  if (dims === undefined) {
    const first = map.values().next().value;
    dims = first?.length ?? 0;
  }
  const dimensions = dims;

  const id = opts.id ?? `static@${dimensions}`;
  const onMiss = opts.onMiss ?? 'throw';

  return {
    id,
    dimensions,
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map(t => {
        const vec = map.get(t);
        if (vec) return vec;
        if (onMiss === 'zeros') return new Array(dimensions).fill(0);
        throw new Error(`[graphnosis] staticEmbedAdapter('${id}'): no vector for input ${JSON.stringify(t.slice(0, 80))}`);
      });
    },
  };
}
