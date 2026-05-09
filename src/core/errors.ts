// Typed errors emitted by the SDK. Consumers should branch on `instanceof`
// rather than string-matching `.message`. New error types added here MUST
// keep `name` matching the class name so V8 stack traces stay readable.

/**
 * Thrown when a saved index's analyzer id does not match the runtime's
 * configured analyzer. Different analyzers produce incompatible token
 * streams — querying a Romanian-tokenized index with the English
 * analyzer would silently return wrong results.
 */
export class AnalyzerMismatchError extends Error {
  readonly name = 'AnalyzerMismatchError';
  constructor(
    public readonly savedAdapterId: string,
    public readonly runtimeAdapterId: string
  ) {
    super(
      `[graphnosis] analyzer mismatch: index was built with '${savedAdapterId}' but the runtime is configured with '${runtimeAdapterId}'. ` +
      `Re-build the index with the matching analyzer or pass { analyzer } to the Graphnosis constructor.`
    );
  }
}

/**
 * Thrown when a saved embedding index's adapter id does not match the
 * runtime's configured embedding adapter. Vector spaces are not
 * interchangeable across providers / models / dimensions / intents.
 */
export class EmbeddingAdapterMismatchError extends Error {
  readonly name = 'EmbeddingAdapterMismatchError';
  constructor(
    public readonly savedAdapterId: string,
    public readonly runtimeAdapterId: string
  ) {
    super(
      `[graphnosis] embedding adapter mismatch: index was built with '${savedAdapterId}' but the runtime is configured with '${runtimeAdapterId}'. ` +
      `Re-embed with the matching adapter or pass { embed } to the Graphnosis constructor.`
    );
  }
}
