# Changelog

## v0.7.3 (2026-06-25)

On-device embedding adapter and the hub-independence (max-wins) retrieval ablation.

### Added

- **Local on-device embedding adapter.** `localEmbedAdapter` runs fastembed
  (BGE-small-en-v1.5, 384-dim) via ONNX Runtime for dense retrieval with no cloud
  calls — the model the desktop app bundles. Internal for now (used by the
  benchmark harness); not yet a public `exports` entry.
- **Hub-independence ablation.** `tests/ablation-scoring/maxwins-vs-additive.ts`
  asserts the traversal's max-score-wins rule is hub-independent: a high-degree
  node is not inflated by edge count, only by its single strongest path, whereas
  additive accumulation promotes it ~N× its degree.
- **Benchmark evidence.** The GPT-4o additive-scoring arm (56.20%) and the
  on-device naïve-top-k baseline (33.20%); the retrieval gain decomposes into
  structure (+11.4) and the scoring rule (+6.0), and the dual graph lifts a 3B
  on-device model +8.4 over flat top-k. Manifest/checksums/README updated.

### Changed

- **Benchmark harness.** `hybrid`/`embeddings` retrieval can select the local
  adapter via `GRAPHNOSIS_EMBED_PROVIDER=local`; run-affecting env vars are
  recorded in the report command. A gated `GNOSIS_SCORE_RULE=additive` branch
  (default off) swaps the traversal scoring rule for the ablation.

## v0.7.2 (2026-06-25)

Retrieval-ablation baselines, a per-graph synonym cache, and the LongMemEval re-baseline to 78.00%.

### Added

- **Retrieval ablation modes.** `answer()` gains `naive-topk` and `full-context`
  retrieval modes (no graph traversal) so the answer model can be held fixed
  while only the retrieval structure varies — used to isolate the memory layer's
  contribution on LongMemEval.
- **Dual-graph / recall micro-benchmark.** `tests/bench/dual-graph-and-recall.ts`
  measures dual-graph coverage, warm-recall latency, and `.gai`-vs-JSON size.

### Changed

- **Per-recall synonym map is now cached per graph.** `buildSynonymMap` memoizes
  on a `(undirectedEdges.size, version, updatedAt)` signature, and `expandQuery`
  runs its term-containment scan once per query instead of once per word. Recall
  output is byte-identical; warm recall drops ~0.13 s at 15k nodes and ~0.5 s at
  45k.

### Docs

- **LongMemEval re-baselined to 78.00%** (390/500, Run 30, on the v0.7.x line),
  updating the README badge, the benchmark history, and the cite-for-publication
  per-category reconciliation. The headline configuration is Graphnosis paired
  with cloud GPT-4o, cloud embeddings, and gpt-4o-mini ingest summaries /
  query-time preference extraction; the substrate — graph, lexical index, and
  contradiction triage — remains zero-API in every configuration.

## v0.7.0 (2026-06-23)

Local answer endpoint and hardened ingest-time contradiction detection.

### Added

- **Pluggable answer LLM.** `answer()` accepts `answerBaseURL` / `answerApiKey`,
  so the answer step can target a local OpenAI-compatible endpoint (e.g. Ollama)
  instead of the cloud. Enables fully on-device question answering and powers
  the offline LongMemEval harness.
- **LongMemEval offline flags.** The official harness gains `--ollama` /
  `--answer-base-url` for local end-to-end runs.

### Changed

- **Ingest contradiction detection is stricter (fewer false positives).**
  Structural entities — bare years, ISO/slash dates, money amounts, and short
  tokens — no longer count toward the shared-anchor requirement, and the weak
  discourse markers `however` / `in fact` / `but actually` were removed from the
  conflict patterns. Genuine corrections (with strong markers) are unaffected.

### Docs

- Benchmarks: methodology labelling, a "what 76.40% is and isn't" disclosure,
  and the Run 23 reconciliation table.
- Added `GRAPHNOSIS.md` (AI-assistant memory instructions).

## v0.6.1 (2026-06-09)

Security and robustness fixes for untrusted-input parsing and `.gai` integrity.
No API changes.

### Security

- **`.gai` reader authenticates before parsing.** The header was
  msgpack-unpacked before the HMAC was verified, feeding the deserializer
  unauthenticated bytes. The reader now derives the trailer layout from whether
  the caller supplied a key (not from the unverified header), checks the
  checksum and — in signed mode — the HMAC over the raw header+body bytes
  *first*, and only then unpacks. Same HMAC coverage as the writer, so it's a
  pure reordering with no format change; downgrade protection is preserved.
- **Replaced the unmaintained `exif-parser@0.1.x`** (last published ~2018, parses
  attacker-controlled EXIF/TIFF IFD structures) with the actively-maintained,
  fuzz-tested `exifr`. Same extracted fields (dimensions, camera, date, GPS,
  attribution).

### Fixed

- **Quadratic ReDoS in markdown-link extraction (`chunker.extractLinks`).** The
  `[text](url)` / `[[wiki]]` patterns used unbounded character classes, making
  the matcher O(n²) on long runs of unbalanced brackets — a few hundred KB of
  crafted content could pin a CPU for minutes. Quantifiers are now bounded, URLs
  exclude whitespace, and the scan is capped at 256 KB. Linear thereafter.
- **Unbounded PDF extraction.** `parsePdf`'s `maxPages` defaulted to `Infinity`
  and no caller set it, so a crafted PDF advertising a huge page count could
  loop unbounded. The default is now `DEFAULT_MAX_PAGES` (2000); pass
  `maxPages: Infinity` to opt out.

## v0.6.0 (2026-06-06)

Performance and a new memory-management API for hosts running large cortexes.

### Added

- **`dispose()` on the `Graphnosis` instance.** Clears the in-memory node/edge
  Maps and the TF-IDF / embedding indexes so a host can evict an idle graph and
  return memory to the OS. Clearing the structures lets GC reclaim the footprint
  even if a reference to the instance lingers — a plain drop-the-reference
  eviction freed almost nothing. After `dispose()` the instance is dead; reload
  the graph from disk to use it again.

### Changed

- **Contradiction detection is entity-indexed instead of an O(N²) scan.**
  `detectNewContradictions` previously scanned every node for every new entity
  and re-lowercased entities on each comparison — O(entities_new × N ×
  entities/node) transient strings, which grew the heap into multi-GB reserved
  pages on large ingests. It now builds a lowercased entity→nodeId index in one
  pass and does direct lookups. Identical results, far less CPU and allocation.

### Internal

- Added a `prepare` script so the package builds when consumed as a git
  dependency.

## v0.5.7 (2026-06-05)

Fix a checksum sign bug that mis-flagged large engrams (above ~17 MB) as
corrupt on load. No breaking changes — affected engrams were never actually
damaged and load correctly with this release.

### Fixed

- **`.gai` checksum verification no longer false-positives on large engrams.**
  `gai-reader.ts` accumulated the additive checksum with a signed 32-bit
  operation (`& 0xffffffff`) while the writer accumulates unsigned (`>>> 0`).
  The two diverge once the cumulative byte sum exceeds the signed int32 range
  (~17 MB of content), so large engrams failed the integrity check on load and
  were reported as corrupt even though their bytes were intact. The reader now
  uses the same unsigned `>>> 0` accumulation as the writer, so checksums match
  at any engram size.

## v0.5.6 (2026-05-28)

Fix `rebuildIndex()` parity with the canonical build path so post-load
recall scores are byte-identical to pre-save scores. Improve PDF text
extraction quality on diacritic-heavy documents. Document the
concurrency contract on `queryHybrid()`. No breaking changes.

### Fixed

- **PDF text extraction preserves diacritics correctly.** The previous
  `pdf-parser.ts` joined pdfjs TextItems with a blind `' '` separator
  and skipped Unicode normalization. PDFs that emit each glyph as a
  separate TextItem — common in Eastern European, Vietnamese, and
  other diacritic-heavy documents — were extracted as space-split
  garbage ("R o m â n i a" instead of "România"), and decomposed
  diacritic sequences (`a` + combining `̆`) never collapsed into
  precomposed forms (`ă`).

  Now `joinPdfItems()` uses position-aware spacing — comparing the
  x-gap between consecutive items against the font size, only
  inserting a space when the gap exceeds 20% of the font size — and
  the joined string is `.normalize('NFC')`'d so combining sequences
  collapse correctly. Ingest of European/Asian/diacritic-heavy PDFs
  now produces searchable content where it previously produced noise.

- **`rebuildIndex()` now matches the canonical TF-IDF policy.** The
  index reconstructed by `fromBuffer()` / `loadGai()` was excluding
  `section`-type nodes from the lexical index, while both the initial
  build (`graph-builder.ts`) and the incremental builder
  (`incremental.ts`) have included them since v0.5.4 / v0.5.5
  respectively. The mismatch silently shifted every IDF score after a
  reload by a small constant factor (`log((N+1) / (df+1)) + 1` with
  different `N` between paths). The user-visible symptom: recall scores
  wobbled by ~0.01 across an open-close-reopen cycle even when nothing
  else changed.

  Fixed by changing `rebuildIndex()` to exclude only `document`-type
  nodes (top-level title duplicates), matching the two other build
  paths. Recall now returns byte-identical prompts pre-close vs
  post-reopen.

  Verified by the [Graphnosis App's consistency
  suite](https://github.com/nehloo/interactive/graphnosis-app):
  `persistence.test.ts` was previously asserting "prompt identical
  modulo TF-IDF score wobble" and is now strict byte-equality. Passes
  5/5 consecutive runs.

### Changed (docs only)

- **`queryHybrid()` JSDoc** now documents the concurrency contract:

  > CONCURRENCY: this method calls `this.embed(question)` synchronously
  > from the caller's perspective — no internal queueing. If your
  > embedding adapter is NOT safe for concurrent invocation (notably
  > fastembed / ONNX Runtime, which terminates the process with
  > "libc++abi: mutex lock failed" on concurrent calls), the caller is
  > responsible for serializing `queryHybrid()` invocations. Wrap each
  > call in a promise chain or async-mutex.

  Behaviour is unchanged; callers that have always run a single
  query at a time are unaffected. Callers that genuinely parallelize
  recall across multiple instances sharing an ONNX worker pool already
  need their own serializer (the Graphnosis App's
  `apps/desktop-sidecar/src/embedding-queue.ts` is a working
  reference pattern).

## v0.5.5 (2026-05-25)

Incremental-build parity with full-rebuild for TF-IDF and reingest-after-forget — no breaking changes.

### Fixed

- **Reingest after forget now works correctly.** The incremental graph builder
  was including soft-deleted nodes (confidence ≤ 0.1) in its dedup hash set,
  which permanently prevented re-ingestion of the same content after a forget.
  Since the correction engine preserves soft-deleted nodes for audit history
  rather than removing them, the dedup check must skip them. Fixed by
  filtering to `confidence > 0.1` when building the existing-hash set.

- **Section-heading nodes are now indexed in TF-IDF for incremental builds.**
  `graph-builder.ts` (full rebuild path) already included section nodes since
  v0.5.4, but `incremental.ts` still excluded them. The two code paths are
  now in sync — headings like "## Sensors" are findable whether a document
  was added via a full rebuild or an incremental update.

## v0.5.4 (2026-05-25)

Crash-safe `.gai` writes, section titles in search, and plural/singular
query morphology — no breaking changes.

### Fixed

- **`.gai` files are now written atomically.** `saveGai()`, `exportGraph`,
  and `updateGraph` all previously called `writeFileSync` directly on the
  live file path. A SIGKILL or power-loss mid-write left a partial msgpack
  blob on disk, which failed the checksum on next load and triggered
  quarantine + op-log recovery. All three now write to a uniquely named
  `.tmp-<pid>-<ts>-<hex>` file, call `fsync(2)` to flush to disk, then
  rename atomically into place. A killed process between the `fsync` and
  the `rename` is no longer destructive — the original `.gai` is untouched.

- **Section-heading nodes are now included in the TF-IDF index.**
  `buildGraph` was excluding both `document` and `section` chunk types from
  the lexical index. Section titles (headings like "Authentication", "API
  Reference") are high-signal, short strings that are exactly what users
  type when searching — they should always be indexed. Only `document`
  nodes (the top-level title, which duplicates section content) remain
  excluded.

### Improved

- **Query-time plural/singular morphological fallback in TF-IDF.** When a
  query term has no exact match in the IDF table, the engine now tries three
  common inflection variants in order: `-es` (matches → match), `-s`
  (sensors → sensor), and `+s` (sensor → sensors). This is query-side only
  — the index is never mutated — so it costs nothing for exact matches and
  requires no re-ingest of existing content. Searches for "notes" now match
  content indexed as "note" and vice versa.

## v0.5.3 (2026-05-24)

Public-API addition for richer downstream consumption + a privacy fix
for SDK-side logging.

### Added

- **`serializeSubgraph` is now exported from the SDK index.** The function
  was already implemented (`@/core/query/subgraph-serializer`) but wasn't
  re-exported from the public surface, forcing consumers either to import
  from an internal path (breaks on publish) or to fall back to flat
  bullet-point prompt rendering. The Graphnosis App uses this to render
  the `=== KNOWLEDGE SUBGRAPH ===` rich format per engram.

### Fixed

- **Source file paths and node ids no longer leak into console logs.**
  Two sites scrubbed via a new `src/sdk/log-redact.ts` helper
  (`redactId` → FNV-1a 32-bit, 8-char hex):

  - `image-parser.ts` vision-analysis failure was logging the full
    source file path (`sourceFile`).
  - `app/api/graph/enrich/route.ts` enrichment failure was logging the
    raw `nodeId`.

  Both now log `file[<hash>]` / `node[<hash>]`. Hashes are stable
  across calls (same id → same hash, so log lines remain greppable for
  one trail) but non-recoverable (cryptographically weak by design —
  the point is privacy hygiene, not authentication).

  Example folder (wikipedia/nextjs-docs/arxiv fetchers) intentionally
  not scrubbed — those are demo apps, not library code.

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
