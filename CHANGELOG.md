# Changelog

## v0.2.0

The "make Graphnosis actually work for non-OpenAI / non-English /
serverless consumers" release. Three breaking changes bundled.

Soaked end-to-end at rc.1 by a v0.1.x production consumer — 10/10
contractual checks passed: buffer I/O + HMAC tamper detection, adapter
`intent` / `signal` wiring, typed mismatch errors, analyzer split.

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

**Embeddings — adopt the adapter contract:**
```diff
- await g.buildEmbeddings({ model: 'text-embedding-3-small' });
+ import { openaiEmbedAdapter } from '@nehloo/graphnosis/adapters/openai';
+ await g.buildEmbeddings({ adapter: openaiEmbedAdapter({ model: 'text-embedding-3-small' }) });
```

**Serverless persistence — drop the `/tmp` round-trip:**

If you were previously writing to a temp file, reading it back, and
uploading the bytes (the typical Vercel / Lambda / Cloudflare pattern):

```diff
- import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
- import { tmpdir } from 'node:os';
- import { join } from 'node:path';
-
- const dir = mkdtempSync(join(tmpdir(), 'graph-'));
- const path = join(dir, 'kg.gai');
- try {
-   g.saveGai(path, { hmacKey });
-   await blob.put('graphs/kg.gai', readFileSync(path));
- } finally {
-   rmSync(dir, { recursive: true, force: true });
- }
+ await blob.put('graphs/kg.gai', g.toBuffer({ hmacKey }));
```

And on the reload path:

```diff
- const dir = mkdtempSync(join(tmpdir(), 'graph-'));
- const path = join(dir, 'kg.gai');
- try {
-   const bytes = await blob.get('graphs/kg.gai');
-   writeFileSync(path, bytes);
-   g.loadGai(path, { hmacKey });
- } finally {
-   rmSync(dir, { recursive: true, force: true });
- }
+ const bytes = await blob.get('graphs/kg.gai');
+ g.fromBuffer(Buffer.from(bytes), { hmacKey });
```

`saveGai` / `loadGai` continue to work as thin wrappers if you have a
real local volume; use `toBuffer` / `fromBuffer` whenever your runtime
doesn't.

**Non-English ingestion — choose your analyzer:**
```diff
- const g = new Graphnosis({ name: 'docs-ro' });
- g.addMarkdown('Cusătura tradițională…');
- g.build();
- g.query('cusătură'); // ✗ silently empty — diacritics dropped in v0.1
+ import { unicodeAnalyzer } from '@nehloo/graphnosis';  // for Turkish / Hungarian / Finnish
+ const g = new Graphnosis({ name: 'docs-ro', analyzer: unicodeAnalyzer });
+ g.addMarkdown('Cusătura tradițională…');
+ g.build();
+ g.query('cusătură'); // ✓
```

(For Romanian / French / Spanish / English-with-foreign-names where
folding to ASCII is acceptable, the v0.2 default `asciiFoldAnalyzer`
already handles `cusatura` and `Beyoncé` ↔ `beyonce` correctly without
extra config.)

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
