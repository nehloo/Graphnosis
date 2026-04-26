// Pluggable embedding adapter.
//
// v0.1.5 hardcoded `@ai-sdk/openai` as the only embedding source. v0.2
// turns this into a small interface that any provider (Voyage, Cohere,
// Bedrock, local sentence-transformers, anything callable from Node) can
// implement. The OpenAI implementation moves to
// `src/sdk/adapters/openai.ts` and becomes one option among many.
//
// Key design choices, all driven by feedback from a production v0.1.5
// consumer:
//
//   1. `intent: 'document' | 'query'` is required. Voyage and Cohere are
//      asymmetric — using doc embeddings for queries silently degrades
//      retrieval. Symmetric providers (OpenAI) ignore the param.
//   2. `signal?: AbortSignal` is optional but built-in. Lets consumers
//      cancel long `buildEmbeddings()` runs on user nav / container
//      shutdown.
//   3. `id` is the persistence anchor. Two adapters with the same `id`
//      MUST produce vectors in the same space — Graphnosis uses this
//      to fail closed at load time when an index is restored against
//      an incompatible runtime.

export interface EmbeddingAdapter {
  /**
   * Stable identifier — persisted on the embedding index. By convention,
   * encode every property that affects the vector space:
   *   - model name
   *   - output dimension
   *   - intent (if the adapter splits document vs. query)
   *
   * Examples:
   *   'openai:text-embedding-3-small@1536'
   *   'openai:text-embedding-3-large@3072'
   *   'voyage:voyage-3-large@1024:document'
   *   'cohere:embed-english-v3.0@1024:document'
   *
   * Two adapters with the same `id` MUST produce vectors that can be
   * cosine-compared. If you change model, dimension, or intent, change
   * the id.
   */
  id: string;

  /** Output dimensionality. Must match the actual vector length. */
  dimensions: number;

  /**
   * Embed N texts; must return exactly N vectors.
   *
   * @param texts   Strings to embed. Empty strings should be filtered by
   *                the caller — most providers reject empty input.
   * @param intent  `'document'` for indexing-time embeddings (default),
   *                `'query'` for retrieval-time embeddings. Asymmetric
   *                providers (Voyage, Cohere) MUST honor this; symmetric
   *                providers (OpenAI) may ignore it.
   * @param signal  Optional `AbortSignal` for cancellation (long
   *                `buildEmbeddings` runs, serverless shutdown, user
   *                navigation away). Adapters SHOULD forward this to
   *                the underlying fetch / SDK call.
   *
   * Implementations are responsible for batching, retries, and rate-limit
   * backoff. Consumers of `EmbeddingAdapter` (i.e. the Graphnosis core)
   * MUST NOT assume the adapter chunks internally — they pass through
   * arbitrarily large text arrays.
   */
  embed(
    texts: string[],
    intent?: 'document' | 'query',
    signal?: AbortSignal
  ): Promise<number[][]>;
}
