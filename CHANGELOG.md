# Changelog

## v0.5.2 (2026-05-20)

Identity extraction wired into the graph build pipeline and social edges upgraded to directed.

### Changed

- **`extractIdentities()` is now called automatically during `buildGraph()`.**
  It was implemented in v0.5.0 but never invoked — person nodes and social
  edges were never actually added to built graphs until now.

- **Person-node threshold lowered to 1+ mentions** (was 2+). Entities
  mentioned even once now get a person node, improving coverage for
  documents that introduce people briefly.

- **Co-mention edges upgraded from undirected `related-to` to symmetric
  directed `knows`.** Two directed edges are emitted (A→B and B→A) so both
  directions render correctly in Atlas. Each edge carries an `evidence`
  field with the co-mention count.

- **Edge type `cites` renamed to `discussed-in`** for the edge connecting
  a content node to the person node it mentions.

## v0.5.1 (2026-05-18)

Single-fix patch for `parseMarkdown` (and therefore `appendMarkdown` and
every other call path that routes through it).

### Fixed

- **`parseMarkdown` on headerless prose now produces a usable document
  instead of silently dropping the content.**

  The parser builds `ParsedDocument.sections` from `#`/`##`/etc. headings
  and attaches content lines to the most-recently-opened section. When
  the input has NO headings at all (a common shape for AI-emitted
  `remember`-style notes), every content line went to a stack-empty
  branch that discarded them — leaving `sections: []`. The chunker
  then had no content sections to walk and emitted zero content nodes,
  surfacing to callers as "ingest produced 0 nodes".

  Fix: when `sections` is empty AND the body (after stripping
  frontmatter) has non-whitespace content, wrap the whole body in a
  single synthetic section with the doc's title as the section
  heading. The chunker now sees a section it can split into content
  chunks the normal way. Empty / whitespace-only / frontmatter-only
  inputs still produce zero chunks (correct behaviour — there's
  nothing to remember).

  No API change. Callers that always passed well-formed markdown with
  a `#` heading see no observable difference.

## v0.5.0 (2026-05-18)

The "ingest tuning + big-PDF safety" release. Two new user-facing preset
families for chunking + embedding throughput, plus durability fixes for
large-graph checksums and big PDFs.

### Added

- **`ChunkSizePreset` — `'fine' | 'balanced' | 'coarse'`.**
  Controls how aggressively the SDK splits documents into memory nodes.
  Threaded through every `append*` method as an optional third argument
  (`opts.chunkSize`):

  ```ts
  await g.appendPdf(buffer, 'manual.pdf', { chunkSize: 'coarse' });
  g.appendMarkdown(content, 'note.md', { chunkSize: 'fine' });
  g.appendWithOptions({ chunkSize: 'coarse' }, doc1, doc2);
  ```

  Numeric mapping:
  | Preset | maxLength | maxSentences |
  |---|---|---|
  | `fine` | 300 chars | ≤ 2 |
  | `balanced` *(default)* | 500 chars | ≤ 3 |
  | `coarse` | 2500 chars | ≤ 6 |

  `balanced` matches the historical `MAX_CHUNK_LENGTH` / `MAX_CHUNK_SENTENCES`
  constants — existing callers see no behaviour change unless they pass
  the new option.

- **`EmbedBatchPreset` — `'small' | 'medium' | 'large' | 'auto'`.**
  `buildEmbeddings()`'s `batchSize` option now accepts a preset label
  in addition to a number. Numeric calls keep working unchanged.

  ```ts
  await g.buildEmbeddings({ batchSize: 'large' });   // 1024 items/call
  await g.buildEmbeddings({ batchSize: 'auto' });    // pick from totalmem()
  await g.buildEmbeddings({ batchSize: 128 });       // explicit number
  ```

  Numeric mapping:
  | Preset | items/call |
  |---|---|
  | `small` | 64 |
  | `medium` *(default)* | 256 |
  | `large` | 1024 |
  | `auto` | totalmem ≥ 32 GB → 1024 · ≥ 16 GB → 256 · else 64 |

  `auto` uses `os.totalmem()` rather than `os.freemem()` — the former is
  stable, the latter underreports on macOS where inactive/cached pages
  are counted as used.

- **`IngestOptions` interface + `appendWithOptions(opts, ...docs)`.**
  Companion of `append(...docs)` that takes an options bag without
  requiring named-overload-style calls. Used internally by all sugar
  methods; exposed publicly for callers that prefer it.

- **`opts.maxPages` on `appendPdf` / `parsePdf`.** Hard cap on pages
  extracted from a PDF. See the "Changed" section below for details.
  Default `Infinity` — additive, non-breaking.

### Changed

- **PDF parser is now page-batched, with a configurable page cap.**
  Previously a single `extractText(pdf, { mergePages: true })` call ran every
  page in one shot — fine for short docs, but a 1000+ page reference manual
  could OOM or time out the host process. The new path extracts in
  10-page batches with an explicit `setImmediate` yield between them,
  so the calling process's event loop stays responsive throughout.

  New `opts.maxPages` on `appendPdf` (and `parsePdf` directly) — **default
  is `Infinity`, so existing callers see no behavioural change**, only
  the new event-loop friendliness. Pass `maxPages` to bound extraction:

  ```ts
  await g.appendPdf(buffer, 'manual.pdf', { maxPages: 100 });
  ```

  Documents longer than `maxPages` get a note appended to the parsed text:
  > `[Note: This PDF has 4233 pages. Only the first 100 pages were ingested.]`

  Parsed-document metadata gained three fields:
  - `pageCount`: total page count in the source PDF
  - `pagesIngested`: how many were actually extracted (≤ `maxPages`)
  - `truncated`: 1 if the cap fired, 0 otherwise

### Fixed

- **`.gai` writer: checksum overflow on large graphs.**
  The additive checksum used `(checksum + byte) & 0xffffffff` to clamp to
  uint32. JavaScript's `&` returns a signed int32 which wraps to negative
  at 2³¹ — `writeUInt32BE` then threw `RangeError` on graphs big enough
  to push the running sum past that boundary. Replaced with `>>> 0`
  (unsigned shift), which is the canonical idiom for "clamp to uint32".
  No on-disk format change; old `.gai` files still verify correctly.

### Internal

- `chunkDocument(doc, opts?)`, `chunkSection(..., limits)`,
  `splitIntoChunks(text, limits)` — option threading down to the
  per-paragraph splitter. Public re-exports limited to the preset types.
- `addDocumentsToGraph(graph, docs, opts?)` — opts bag with `chunkSize`.
- `resolveEmbedBatchSize(input)` — preset → number resolver in the SDK
  facade. Internal helper; not exported.

## v0.4.0 (2026-05-16)

**Copyright transferred to Nehloo Interactive LLC. License unchanged (Apache-2.0).**

### Changed

- **PDF parser: `pdf-parse@2` → `unpdf`.**  
  `pdf-parse@2` uses `pdfjs-dist@5` under the hood and routes all Node
  invocations through a `LoopbackPort` path that fails on `structuredClone`
  with complex PDF internal objects — unfixable from outside the library.
  Replaced with `unpdf`, which wraps the same pdfjs engine but is configured
  for serverless/Node runtimes and avoids the broken code path entirely.  
  API surface of `parsePdf()` is unchanged; text quality, page count, and
  metadata (Title, Author) are equivalent.  
  `pdf-parse` is no longer a dependency.

### Internal

- `author` field in `package.json` updated to **Nehloo Interactive LLC**
  (was the prior individual author name).

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
