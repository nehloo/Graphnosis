// Local, on-device embedding adapter — fastembed (BGE-small-en-v1.5, 384-dim)
// via ONNX Runtime: the same model the Graphnosis desktop application ships.
// Lets the benchmark measure hybrid retrieval with NO cloud embedding calls
// (the fully-on-device dense arm).
//
// fastembed + onnxruntime-node are optional: this module is only imported when
// the local provider is selected, so the dependency stays out of the way for
// everyone else (mirrors the OpenAI adapter's lazy peer-dep pattern).
//
// CONCURRENCY: onnxruntime-node crashes on concurrent invocation
// ("libc++abi: mutex lock failed"). Every embed() call is therefore serialized
// through a promise chain — one batch in flight at a time. The benchmark also
// runs embedding modes at concurrency 1, so this is belt-and-suspenders.

import os from 'node:os';
import path from 'node:path';
import type { EmbeddingAdapter } from '@/core/similarity/embedding-adapter';

export interface LocalEmbedAdapterOptions {
  /** Model cache dir. Defaults to the desktop app's cache so an existing
   *  download is reused rather than re-fetched. */
  cacheDir?: string;
  /** Texts per fastembed batch. Default 32. */
  batchSize?: number;
}

function defaultCacheDir(): string {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Caches', 'GraphnosisApp', 'models');
  }
  return path.join(home, '.cache', 'GraphnosisApp', 'models');
}

export function localEmbedAdapter(opts: LocalEmbedAdapterOptions = {}): EmbeddingAdapter {
  const batchSize = opts.batchSize ?? 128; // larger batch → better ONNX CPU throughput for bulk corpus embedding
  const cacheDir = opts.cacheDir ?? process.env.GRAPHNOSIS_EMBED_CACHE ?? defaultCacheDir();

  // Lazy single-load of fastembed + the model.
  let modelPromise: Promise<{ embed(texts: string[], batchSize?: number): AsyncIterable<Array<Float32Array | number[]>> }> | undefined;
  async function getModel() {
    if (!modelPromise) {
      modelPromise = (async () => {
        // fastembed's module shape differs across CJS/ESM interop; `any` keeps the
        // destructure simple for this internal benchmark adapter.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const fe: any = await import('fastembed');
        const { FlagEmbedding, EmbeddingModel } = fe.default ?? fe;
        return FlagEmbedding.init({
          model: EmbeddingModel.BGESmallENV15, // 384-dim, ~30 MB; matches the app default
          cacheDir,
          showDownloadProgress: true,
          maxLength: 512,
        });
      })();
    }
    return modelPromise;
  }

  // Serialization mutex — chain every embed() so two never run concurrently.
  let chain: Promise<unknown> = Promise.resolve();

  return {
    id: 'graphnosis-app:bge-small-en-v1.5@384',
    dimensions: 384,
    embed(texts: string[], _intent?: 'document' | 'query', _signal?: AbortSignal): Promise<number[][]> {
      // The shipped product embeds queries and documents identically (no
      // BGE query prefix), so we ignore `intent` to match its behavior.
      if (texts.length === 0) return Promise.resolve([]);
      const run = chain.then(async () => {
        const model = await getModel();
        const out: number[][] = [];
        for await (const batch of model.embed(texts, batchSize)) {
          for (const v of batch) out.push(Array.from(v as Float32Array));
        }
        return out;
      });
      // Keep the chain alive even if a call rejects, so later calls still serialize.
      chain = run.then(() => undefined, () => undefined);
      return run;
    },
  };
}
