# Changelog

## v0.2.0-rc.1 (unreleased)

The "make Graphnosis actually work for non-OpenAI / non-English /
serverless consumers" release. Three breaking changes bundled.

### BREAKING

- **Embedding adapter contract.** `g.buildEmbeddings({ model })` no longer
  accepts a `model` field. Pass `adapter: openaiEmbedAdapter({ model })`
  instead, or set `embed: openaiEmbedAdapter(...)` on the constructor and
  call `buildEmbeddings()` with no args. Custom embedding implementations
  must conform to the new `EmbeddingAdapter` interface — `embed(texts,
  intent?, signal?)` — including honoring `intent: 'document' | 'query'`
  for asymmetric providers (Voyage, Cohere).

- **Peer dependency layout.** `ai` and `@ai-sdk/openai` are still peer
  deps, but they are only loaded when you import
  `@nehloo/graphnosis/adapters/openai`. Consumers using Voyage / Cohere /
  custom adapters never touch them.

- **`TfidfIndex` carries `provenance`.** `TfidfIndex` and `EmbeddingIndex`
  both gained a `provenance: IndexProvenance` field
  (`{ adapterId, createdAt, checksum? }`). `GraphMetadata` gained
  `analyzerAdapterId`. **v0.1 `.gai` files are NOT supported** —
  re-build any v0.1 graphs against v0.2 (no production v0.1 deployments
  existed at the time of the v0.2 cut, so no migration path is shipped).

- **`getCosineSimilarity` removed from the public surface.** It was a
  redundant async re-export of `ai`'s cosineSimilarity. The internal
  cosine helpers in `@/core/similarity/cosine.ts` are still used.

- **Internal soft-delete defaults rebranded.** `cascadeSoftDelete`,
  `forgetByTimeWindow`, `forgetByTopic`, `g.forgetBefore`, and
  `g.forgetTopic` now use `system:*` / `user:*` prefixes by default
  instead of freeform strings. If you query soft-delete reasons by
  exact-match, update your strings.

### Added

- **Buffer-based persistence** — `g.toBuffer()` / `g.fromBuffer()` /
  `g.toSqliteBuffer()` / `g.fromSqliteBuffer()`. Designed for serverless
  / edge runtimes where round-tripping through `/tmp` is wasteful. The
  filesystem-based `saveGai`/`loadGai`/`saveSqlite`/`loadSqlite*` keep
  working as thin wrappers.

- **Pluggable text analyzer.** `new Graphnosis({ analyzer })` accepts a
  `TextAnalyzer`. Two built-ins ship:
  - `asciiFoldAnalyzer` *(default, id `ascii-fold`)* — NFD-normalize +
    strip diacritics + English stopwords. `café` and `cafe` collapse
    to one token. Works for English, English-with-foreign-names, and
    Latin-script languages where folding to ASCII is acceptable
    retrieval (Romanian, French, Spanish, Polish, …).
  - `unicodeAnalyzer` *(id `unicode`)* — Unicode-aware split, preserves
    diacritics, no stopwords. Use for Turkish (`ı` ≠ `i`), Hungarian,
    Finnish, anywhere phonemic distinctions matter.

  Stemming-aware language analyzers (Snowball, Zemberek, …) belong in a
  future `@nehloo/graphnosis-langs` companion package.

- **Pluggable embedding adapter.** `new Graphnosis({ embed })` accepts
  an `EmbeddingAdapter`. Built-in adapters at
  `@nehloo/graphnosis/adapters/openai` (`openaiEmbedAdapter`) and
  `@nehloo/graphnosis/adapters/static` (`staticEmbedAdapter` for tests).
  See `src/sdk/adapters/README.md` for the full contract and a Voyage
  example.

- **Typed errors.** `AnalyzerMismatchError` and
  `EmbeddingAdapterMismatchError` are now thrown (not generic `Error`)
  when a saved index is loaded against an incompatible runtime
  configuration.

- **`AbortSignal` on embedding paths.** `buildEmbeddings({ signal })`,
  `queryHybrid(_, { signal })`, `promptHybrid(_, { signal })`, and
  `appendWithEmbeddings` forward an optional `AbortSignal` to the
  adapter for cancellation.

- **Audit reason-prefix filter.** `generateAuditReport(graph, tfidf,
  { hideReasonPrefixes })` and `shouldHideReason(reason, opts)`
  helpers. Default behavior: hide `preview:*` reasons. See
  README "Reason conventions for soft-delete".

### Removed

- `getCosineSimilarity` (see BREAKING).

### Migration cookbook

```diff
- await g.buildEmbeddings({ model: 'text-embedding-3-small' });
+ import { openaiEmbedAdapter } from '@nehloo/graphnosis/adapters/openai';
+ await g.buildEmbeddings({ adapter: openaiEmbedAdapter({ model: 'text-embedding-3-small' }) });
```

```diff
- writeFileSync('/tmp/kg.gai', g.toBuffer());           // already buffer-native
- await blob.put('kg.gai', readFileSync('/tmp/kg.gai'));
+ await blob.put('kg.gai', g.toBuffer({ hmacKey }));
```

```diff
- const g = new Graphnosis({ name: 'docs-ro' });
- g.addMarkdown('Cusătura tradițională…');
- g.build();
- g.query('cusătură'); // ✗ silently empty — diacritics dropped
+ import { unicodeAnalyzer } from '@nehloo/graphnosis';
+ const g = new Graphnosis({ name: 'docs-ro', analyzer: unicodeAnalyzer });
+ g.addMarkdown('Cusătura tradițională…');
+ g.build();
+ g.query('cusătură'); // ✓
```

---

## v0.1.5

- `buildEmbeddings()` / `queryHybrid()` / `promptHybrid()` /
  `appendWithEmbeddings()` (OpenAI-only). Superseded in v0.2 by the
  pluggable adapter.

## v0.1.4

- `loadSqliteByName` + auto-rebuild TF-IDF on load.

## v0.1.3

- `appendPdf` / `appendFile` / `appendFolder` + `AppendResult` with
  contradictions, `g.reflect()`.
