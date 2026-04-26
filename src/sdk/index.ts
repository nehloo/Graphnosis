// Graphnosis SDK — public entrypoint for using Graphnosis as an NPM dependency.
//
// SECURITY INVARIANTS (enforced by what we re-export, not by runtime checks):
//   1. The DEFAULT code path performs ZERO network I/O. The sync methods
//      `query()` / `prompt()` and every `addX` / `appendX` / `save*` /
//      `load*` method are fully offline. This module must not import from
//      `@/core/enrichment/*` or from `@/core/query/answer.ts` — both of
//      those reach OpenAI. Preserve that property when modifying this file.
//      Enterprise adopters verify the no-egress guarantee by auditing the
//      symbols listed in invariant 4 — every other code path on this
//      facade (including the async PDF / file / folder ingestion methods)
//      is fully offline.
//   2. `.gai` files that cross a trust boundary must be written AND read
//      with `hmacKey`. The default additive checksum catches corruption,
//      NOT tampering.
//   3. File paths passed to `saveGai/loadGai/saveSqlite/loadSqlite` are
//      forwarded to `node:fs` and `better-sqlite3` as-is. Do NOT pass
//      user-controlled strings; canonicalize before calling.
//   4. EMBEDDING CARVE-OUT: the symbols `attachEmbeddings`, `embedNodes`,
//      `embedQuery`, and the `Graphnosis` methods `buildEmbeddings()`,
//      `queryHybrid()`, `promptHybrid()`, `appendWithEmbeddings()` DO
//      reach the network via the configured `EmbeddingAdapter`. The
//      adapter is the only egress point — by default the SDK ships
//      with no built-in adapter at all. Importing
//      `@nehloo/graphnosis/adapters/openai` activates `ai` +
//      `@ai-sdk/openai` peer deps; importing
//      `@nehloo/graphnosis/adapters/static` is offline (no peer deps).
//      Custom adapters' egress profile is up to the adapter author.
//      The no-egress guarantee in invariant 1 holds for any code path
//      that does not touch these symbols — the regular sync `append*()`
//      methods do NOT update the embedding index. Audit your call sites.
//
// See `enterprise/enterprise.md` for the full IT/security posture.

import { readFileSync, writeFileSync, readdirSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type {
  KnowledgeGraph,
  ParsedDocument,
  QueryResult,
  Contradiction,
} from '@/core/types';
import { buildGraph, attachEmbeddings, type BuiltGraph } from '@/core/graph/graph-builder';
import { embedNodes, embedQuery } from '@/core/similarity/embeddings';
import type { EmbeddingAdapter } from '@/core/similarity/embedding-adapter';
import { EmbeddingAdapterMismatchError } from '@/core/errors';
import { parseMarkdown } from '@/core/ingestion/parsers/markdown-parser';
import { parseHtml } from '@/core/ingestion/parsers/html-parser';
import { parseCsv, parseJson } from '@/core/ingestion/parsers/csv-parser';
import { parsePdf } from '@/core/ingestion/parsers/pdf-parser';
import {
  queryGraph,
  buildGraphPrompt,
  type QueryOptions,
  type PromptContext,
} from '@/core/query/query-engine';
import { writeGai, type WriteGaiOptions } from '@/core/format/gai-writer';
import { readGai, type ReadGaiOptions } from '@/core/format/gai-reader';
import { openSqliteStore } from '@/core/persistence/sqlite-store';
import { createTfidfIndex, addDocument, computeIdf } from '@/core/similarity/tfidf';
import {
  asciiFoldAnalyzer,
  type TextAnalyzer,
} from '@/core/similarity/analyzer';
import { AnalyzerMismatchError } from '@/core/errors';
import { addDocumentsToGraph } from '@/core/graph/incremental';
import { reflect, type ReflectionResult } from '@/core/optimization/reflection';
import {
  applyCorrection,
  importCorrections,
  forgetByTimeWindow,
  forgetByTopic,
  type Correction,
  type CorrectionResult,
} from '@/core/corrections/correction-engine';

/** Returned by all append* methods. */
export interface AppendResult {
  /** Number of new (non-duplicate) nodes added to the graph. */
  newNodes: number;
  newDirectedEdges: number;
  newUndirectedEdges: number;
  /**
   * Contradictions detected between newly-added nodes and the existing graph.
   * Each entry describes two nodes that share entities but make conflicting
   * claims. The graph is NOT automatically modified — you decide how to
   * resolve each one via `g.supersede()`, `g.deleteNode()`, or `g.edit()`.
   */
  contradictions: Contradiction[];
  /** Files skipped during appendFolder (unsupported extension or read error). */
  skipped?: Array<{ file: string; reason: string }>;
}

/** Supported extensions for appendFile / appendFolder. */
const SUPPORTED_EXTENSIONS = new Set([
  '.md', '.txt', '.html', '.htm', '.csv', '.json', '.pdf',
]);

/** Detect contradictions only among the newly added node IDs vs the full graph. */
function detectNewContradictions(
  graph: KnowledgeGraph & { tfidfIndex?: import('@/core/types').TfidfIndex },
  newNodeIds: Set<string>
): Contradiction[] {
  if (newNodeIds.size === 0 || !graph.tfidfIndex) return [];

  // Build entity → nodeId index scoped to new + existing nodes that share entities with new
  const entityToNew = new Map<string, string[]>();
  for (const nodeId of newNodeIds) {
    const node = graph.nodes.get(nodeId);
    if (!node || node.type === 'document' || node.type === 'section') continue;
    for (const entity of node.entities) {
      if (entity.length < 4) continue;
      const list = entityToNew.get(entity) ?? [];
      list.push(nodeId);
      entityToNew.set(entity, list);
    }
  }

  // For each entity touched by new nodes, find existing nodes that also mention it
  const CONFLICT_PATTERNS = [
    /\b(reclassified|reclassify|disputed|disproven|debunked|refuted|retracted|superseded|corrected|not\s+actually|contrary\s+to|in\s+fact|however|but\s+actually|wrong|incorrect|false)\b/i,
  ];

  const contradictions: Contradiction[] = [];
  const seen = new Set<string>();

  for (const [entity, newIds] of entityToNew) {
    for (const [existingId, existingNode] of graph.nodes) {
      if (newIds.includes(existingId)) continue;
      if (existingNode.type === 'document' || existingNode.type === 'section') continue;
      if (!existingNode.entities.some(e => e.toLowerCase() === entity.toLowerCase())) continue;

      for (const newId of newIds) {
        const pairKey = [newId, existingId].sort().join('|');
        if (seen.has(pairKey)) continue;
        seen.add(pairKey);

        const newNode = graph.nodes.get(newId)!;
        const sharedEntities = newNode.entities.filter(e =>
          existingNode.entities.some(be => be.toLowerCase() === e.toLowerCase())
        );
        if (sharedEntities.length < 2) continue;
        if (newNode.content.length < 60 || existingNode.content.length < 60) continue;

        const newHasConflict = CONFLICT_PATTERNS.some(p => p.test(newNode.content));
        const existingHasConflict = CONFLICT_PATTERNS.some(p => p.test(existingNode.content));
        if (!newHasConflict && !existingHasConflict) continue;

        contradictions.push({
          nodeA: newId,
          nodeB: existingId,
          sharedEntities,
          description: `New content conflicts with existing node on: ${sharedEntities.slice(0, 3).join(', ')}`,
          detectedAt: Date.now(),
          resolved: false,
        });
      }
    }
  }

  return contradictions;
}

export interface GraphnosisOptions {
  /** Name attached to the built graph. Defaults to "graphnosis". */
  name?: string;
  /**
   * Text analyzer for TF-IDF tokenization. Defaults to
   * `asciiFoldAnalyzer` (diacritic-folded ASCII + English stopwords —
   * `café` and `cafe` collapse to the same token).
   *
   * For corpora where diacritics carry meaning (Turkish, Hungarian,
   * Finnish, anywhere `ı` ≠ `i`) pass `unicodeAnalyzer` (preserves
   * diacritics, no stopword list) or implement `TextAnalyzer` yourself.
   *
   * The analyzer's `id` is persisted on the index — loading an index
   * built with a different analyzer throws `AnalyzerMismatchError`.
   */
  analyzer?: TextAnalyzer;
  /**
   * Default embedding adapter used by `buildEmbeddings()`,
   * `queryHybrid()`, `promptHybrid()`, and `appendWithEmbeddings()`.
   *
   * For OpenAI: `openaiEmbedAdapter({ model })` from
   * `@nehloo/graphnosis/adapters/openai`. For Voyage / Cohere / custom,
   * implement `EmbeddingAdapter` directly. Tests can use
   * `staticEmbedAdapter({ vectors })` from `@nehloo/graphnosis/adapters/static`.
   *
   * NETWORK: this adapter is the only opt-in network egress point for
   * the SDK (the rest of the API is fully offline). Audit your call
   * sites accordingly. See SECURITY INVARIANT #4.
   */
  embed?: EmbeddingAdapter;
}

/**
 * Retrieval strategy for `queryHybrid` / `promptHybrid`.
 *
 * - `'hybrid'` (default) — merges TF-IDF and embedding seed pools so the
 *   subgraph contains both literal and semantic matches.
 * - `'embeddings'` — pure semantic; skips the TF-IDF pool entirely.
 *
 * For pure-lexical, fully offline retrieval, call `query()` / `prompt()`
 * instead — those are sync and never reach the network.
 */
export type SimilarityMode = 'tfidf' | 'embeddings' | 'hybrid';

export interface HybridQueryOptions extends QueryOptions {
  /** Default `'hybrid'`. See {@link SimilarityMode}. */
  similarity?: 'hybrid' | 'embeddings';
  /** Optional AbortSignal forwarded to the embedding adapter. */
  signal?: AbortSignal;
}

/**
 * Ingests documents, builds a dual-graph, and answers questions against it.
 *
 * ```ts
 * import { Graphnosis } from '@nehloo/graphnosis';
 *
 * const g = new Graphnosis({ name: 'docs' });
 * g.addMarkdown(readmeText, 'README.md');
 * g.build();
 *
 * const ctx = g.query('how does chunking work?');
 * console.log(ctx.subgraph.serialized);
 * ```
 *
 * WARNING: any document added here eventually flows into the LLM system
 * prompt via `prompt()`. If documents come from untrusted sources, treat
 * node content as indirect-prompt-injection payload surface. See
 * `enterprise/enterprise.md` for mitigations.
 */
export class Graphnosis {
  private documents: ParsedDocument[] = [];
  private name: string;
  private built: BuiltGraph | null = null;
  private analyzer: TextAnalyzer;
  /**
   * Default embedding adapter, set on the constructor or by passing an
   * adapter to `buildEmbeddings()`. Re-used for query embeddings and
   * incremental appends so the vector space stays consistent.
   */
  private embed: EmbeddingAdapter | null = null;

  constructor(opts: GraphnosisOptions = {}) {
    this.name = opts.name ?? 'graphnosis';
    this.analyzer = opts.analyzer ?? asciiFoldAnalyzer;
    this.embed = opts.embed ?? null;
  }

  /** Add a pre-parsed document. */
  addDocument(doc: ParsedDocument): this {
    this.documents.push(doc);
    this.built = null;
    return this;
  }

  addMarkdown(content: string, source = 'inline.md'): this {
    return this.addDocument(parseMarkdown(content, source));
  }

  addHtml(html: string, source = 'inline.html'): this {
    return this.addDocument(parseHtml(html, source));
  }

  addCsv(csv: string, source = 'inline.csv'): this {
    return this.addDocument(parseCsv(csv, source));
  }

  addJson(json: string, source = 'inline.json'): this {
    return this.addDocument(parseJson(json, source));
  }

  /** Treat arbitrary text as a single-section markdown document. */
  addText(text: string, source = 'inline.txt'): this {
    const wrapped = `# ${source}\n\n${text}`;
    return this.addDocument(parseMarkdown(wrapped, source));
  }

  // --- Incremental append ---------------------------------------------------

  /**
   * Append one or more pre-parsed documents to an **already-built** graph
   * without triggering a full rebuild. New nodes are chunk-deduplicated
   * against the existing graph (by content hash), new edges are wired in
   * incrementally, and the TF-IDF index is updated in place.
   *
   * Returns an `AppendResult` that includes any contradictions detected
   * between the new content and existing nodes. The graph is NOT
   * automatically modified on contradiction — you decide how to resolve
   * each one via `g.supersede()`, `g.deleteNode()`, or `g.edit()`.
   *
   * Call `build()` first if the graph has not been built yet.
   */
  append(...docs: ParsedDocument[]): AppendResult {
    const incremental = addDocumentsToGraph(this.graph, docs);
    const contradictions = detectNewContradictions(
      this.graph,
      new Set(incremental.newNodeIds)
    );
    return { ...incremental, contradictions };
  }

  /**
   * Same as `append()` but also embeds any newly added nodes into the
   * existing `embeddingIndex` so `queryHybrid()` / `promptHybrid()` see
   * them immediately.
   *
   * Throws if `buildEmbeddings()` has not been called. For graphs without
   * an embedding index, use `append()` (the regular sync method).
   *
   * NETWORK: makes one OpenAI batch call when there are new nodes to embed.
   */
  async appendWithEmbeddings(...docs: ParsedDocument[]): Promise<AppendResult> {
    const index = this.graph.embeddingIndex;
    if (!index) {
      throw new Error(
        '[graphnosis] appendWithEmbeddings(): call await g.buildEmbeddings() first'
      );
    }
    if (!this.embed) {
      throw new Error(
        '[graphnosis] appendWithEmbeddings(): no embedding adapter configured. Pass { embed } to the constructor or call buildEmbeddings({ adapter }).'
      );
    }
    // Reach into addDocumentsToGraph directly so we can keep newNodeIds —
    // the public AppendResult intentionally hides them.
    const incremental = addDocumentsToGraph(this.graph, docs);
    const contradictions = detectNewContradictions(
      this.graph,
      new Set(incremental.newNodeIds)
    );
    await this.embedNewNodes(incremental.newNodeIds);
    return { ...incremental, contradictions };
  }

  /** Internal: embed the given node ids into the existing embedding index. */
  private async embedNewNodes(newNodeIds: string[]): Promise<void> {
    const index = this.graph.embeddingIndex;
    if (!index || !this.embed) return;
    if (newNodeIds.length === 0) return;
    const items: Array<{ nodeId: string; text: string }> = [];
    for (const id of newNodeIds) {
      const node = this.graph.nodes.get(id);
      if (!node) continue;
      if (node.type === 'document' || node.type === 'section') continue;
      if (!node.content || !node.content.trim()) continue;
      items.push({ nodeId: id, text: node.content });
    }
    if (items.length === 0) return;
    await embedNodes(index, this.embed, items, { intent: 'document' });
  }

  /** Parse markdown and append. Returns AppendResult with contradictions. */
  appendMarkdown(content: string, source = 'inline.md'): AppendResult {
    return this.append(parseMarkdown(content, source));
  }

  /** Parse plain text (wrapped as single-section markdown) and append. */
  appendText(text: string, source = 'inline.txt'): AppendResult {
    return this.append(parseMarkdown(`# ${source}\n\n${text}`, source));
  }

  appendHtml(html: string, source = 'inline.html'): AppendResult {
    return this.append(parseHtml(html, source));
  }

  appendCsv(csv: string, source = 'inline.csv'): AppendResult {
    return this.append(parseCsv(csv, source));
  }

  appendJson(json: string, source = 'inline.json'): AppendResult {
    return this.append(parseJson(json, source));
  }

  /**
   * Parse a PDF buffer and append its content to the graph.
   *
   * ```ts
   * import { readFileSync } from 'node:fs';
   * const result = await g.appendPdf(readFileSync('report.pdf'), 'report.pdf');
   * ```
   */
  async appendPdf(buffer: Buffer, source = 'document.pdf'): Promise<AppendResult> {
    const doc = await parsePdf(buffer, source);
    return this.append(doc);
  }

  /**
   * Auto-detect the format of a file by extension, read it, parse it, and
   * append to the graph. Supported: `.md` `.txt` `.html` `.htm` `.csv`
   * `.json` `.pdf`
   *
   * ```ts
   * const result = await g.appendFile('/uploads/report.pdf');
   * if (result.contradictions.length > 0) {
   *   // show conflicts to user for approval
   * }
   * ```
   */
  async appendFile(filePath: string): Promise<AppendResult> {
    const ext = extname(filePath).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      throw new Error(
        `[graphnosis] Unsupported file extension "${ext}" for ${filePath}. ` +
        `Supported: ${[...SUPPORTED_EXTENSIONS].join(', ')}`
      );
    }
    if (ext === '.pdf') {
      return this.appendPdf(readFileSync(filePath), filePath);
    }
    const content = readFileSync(filePath, 'utf8');
    switch (ext) {
      case '.md': case '.txt': return this.appendMarkdown(content, filePath);
      case '.html': case '.htm': return this.appendHtml(content, filePath);
      case '.csv': return this.appendCsv(content, filePath);
      case '.json': return this.appendJson(content, filePath);
      default: return this.appendText(content, filePath);
    }
  }

  /**
   * Walk a directory and append all supported files. Skips unsupported
   * extensions and files that fail to parse (reported in `result.skipped`).
   *
   * @param dirPath   Absolute or relative path to the folder.
   * @param opts.recursive  Walk subdirectories (default: true).
   * @param opts.extensions Override the set of accepted extensions.
   *
   * ```ts
   * const result = await g.appendFolder('/docs', { recursive: true });
   * console.log(`Added ${result.newNodes} nodes, skipped ${result.skipped?.length} files`);
   * for (const c of result.contradictions) {
   *   console.warn('Conflict:', c.description);
   * }
   * ```
   *
   * WARNING: `dirPath` is forwarded to `fs.readdirSync` unchanged. Do not
   * pass user-controlled strings; canonicalize and validate before calling.
   */
  async appendFolder(
    dirPath: string,
    opts: { recursive?: boolean; extensions?: Set<string> } = {}
  ): Promise<AppendResult> {
    const { recursive = true, extensions = SUPPORTED_EXTENSIONS } = opts;
    const skipped: Array<{ file: string; reason: string }> = [];
    const allDocs: ParsedDocument[] = [];

    const walk = async (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const stat = statSync(full);
        if (stat.isDirectory()) {
          if (recursive) await walk(full);
          continue;
        }
        const ext = extname(entry).toLowerCase();
        if (!extensions.has(ext)) {
          skipped.push({ file: full, reason: `unsupported extension "${ext}"` });
          continue;
        }
        try {
          if (ext === '.pdf') {
            allDocs.push(await parsePdf(readFileSync(full), full));
          } else {
            const content = readFileSync(full, 'utf8');
            switch (ext) {
              case '.md': case '.txt': allDocs.push(parseMarkdown(content, full)); break;
              case '.html': case '.htm': allDocs.push(parseHtml(content, full)); break;
              case '.csv': allDocs.push(parseCsv(content, full)); break;
              case '.json': allDocs.push(parseJson(content, full)); break;
              default: allDocs.push(parseMarkdown(`# ${entry}\n\n${content}`, full));
            }
          }
        } catch (err) {
          skipped.push({ file: full, reason: (err as Error).message });
        }
      }
    };

    await walk(dirPath);

    if (allDocs.length === 0) {
      return { newNodes: 0, newDirectedEdges: 0, newUndirectedEdges: 0, contradictions: [], skipped };
    }

    const result = this.append(...allDocs);
    return { ...result, skipped };
  }

  /**
   * Build the dual graph from all added documents. Safe to call multiple
   * times — the previous graph is discarded and rebuilt.
   */
  build(name?: string): BuiltGraph {
    if (name) this.name = name;
    this.built = buildGraph(this.documents, this.name, this.analyzer);
    return this.built;
  }

  // --- Embeddings (network) -------------------------------------------------

  /**
   * Embed every content node and attach an in-memory `EmbeddingIndex` to
   * the graph. After this resolves, `queryHybrid()` and `promptHybrid()`
   * are usable. Subsequent `appendWithEmbeddings()` calls keep the index
   * in sync (one network call per append batch).
   *
   * NETWORK: calls the configured embedding adapter. The adapter is
   * resolved as `opts.adapter ?? this.embed` — pass one or the other.
   *
   * NOT PERSISTED: embedding vectors are NOT written by `saveGai()` /
   * `saveSqlite()`. After `loadGai()` / `loadSqlite()` you must call
   * `buildEmbeddings()` again to re-embed.
   *
   * @param opts.adapter    Embedding adapter (overrides constructor `embed`).
   * @param opts.batchSize  Items per adapter call. Default 256.
   * @param opts.onProgress Called after each batch with `{ done, total }`.
   * @param opts.signal     Optional AbortSignal for cancellation.
   */
  async buildEmbeddings(opts: {
    adapter?: EmbeddingAdapter;
    batchSize?: number;
    onProgress?: (info: { done: number; total: number }) => void;
    signal?: AbortSignal;
  } = {}): Promise<void> {
    const adapter = opts.adapter ?? this.embed;
    if (!adapter) {
      throw new Error(
        '[graphnosis] buildEmbeddings(): no embedding adapter configured. ' +
        'Pass { adapter } here, or set { embed } on the constructor. ' +
        'For OpenAI, use openaiEmbedAdapter() from @nehloo/graphnosis/adapters/openai.'
      );
    }
    // Persist the adapter so subsequent queryHybrid / promptHybrid /
    // appendWithEmbeddings calls re-use the same vector space.
    this.embed = adapter;
    await attachEmbeddings(this.graph, adapter, {
      batchSize: opts.batchSize,
      onProgress: opts.onProgress,
      signal: opts.signal,
    });
    // Stamp on graph metadata for visibility in g.stats() and audit.
    this.graph.metadata.embeddingAdapterId = adapter.id;
  }

  /** True if `buildEmbeddings()` has run and the index is attached. */
  hasEmbeddings(): boolean {
    return !!this.built?.embeddingIndex;
  }

  /**
   * Hybrid retrieval: merges TF-IDF and embedding seed pools so the
   * subgraph contains both literal and semantic matches. Pass
   * `{ similarity: 'embeddings' }` to skip the TF-IDF pool entirely.
   *
   * NETWORK: makes one adapter call per invocation to embed the question.
   * Requires `await g.buildEmbeddings()` to have run.
   */
  async queryHybrid(
    question: string,
    opts: HybridQueryOptions = {}
  ): Promise<Omit<QueryResult, 'answer'>> {
    const g = this.graph;
    const index = g.embeddingIndex;
    if (!index) {
      throw new Error(
        '[graphnosis] queryHybrid(): call await g.buildEmbeddings() before queryHybrid()'
      );
    }
    if (!this.embed) {
      throw new Error(
        '[graphnosis] queryHybrid(): no embedding adapter configured. ' +
        'Pass { embed } to the constructor or call buildEmbeddings({ adapter }).'
      );
    }
    // Fail closed on adapter / index space mismatch — querying with a
    // different vector space silently returns garbage.
    if (this.embed.id !== index.provenance.adapterId) {
      throw new EmbeddingAdapterMismatchError(index.provenance.adapterId, this.embed.id);
    }
    const queryEmbedding = await embedQuery(this.embed, question, { signal: opts.signal });
    if (!queryEmbedding) {
      // Empty/whitespace question — fall back to the plain (sync) query path.
      const { similarity: _s, signal: _sig, ...rest } = opts;
      void _s; void _sig;
      return queryGraph(g, g.tfidfIndex, question, rest);
    }
    const { similarity, signal: _sig, ...rest } = opts;
    void _sig;
    return queryGraph(g, g.tfidfIndex, question, {
      ...rest,
      embeddingIndex: index,
      queryEmbedding,
      embeddingsOnly: similarity === 'embeddings',
    });
  }

  /**
   * Hybrid prompt builder: same as `prompt()` but uses `queryHybrid()` for
   * retrieval. NETWORK: one adapter call per invocation.
   */
  async promptHybrid(
    question: string,
    opts: HybridQueryOptions & PromptContext = {}
  ): Promise<string> {
    const { questionDate, questionType, ...queryOpts } = opts;
    const result = await this.queryHybrid(question, queryOpts);
    return buildGraphPrompt(result.subgraph.serialized, question, {
      questionDate,
      questionType,
    });
  }

  /** Access the built graph. Throws if build() was not called. */
  get graph(): BuiltGraph {
    if (!this.built) throw new Error('[graphnosis] call .build() before accessing the graph');
    return this.built;
  }

  /** Retrieve a query-scoped subgraph (no LLM call). */
  query(question: string, opts: QueryOptions = {}): Omit<QueryResult, 'answer'> {
    const g = this.graph;
    return queryGraph(g, g.tfidfIndex, question, opts);
  }

  /**
   * Build the LLM system prompt that wraps the subgraph context.
   *
   * WARNING: the returned string contains node `content` verbatim and will
   * be passed directly to an LLM by the caller. If any ingested document
   * originated from untrusted input, the resulting prompt is an indirect
   * prompt-injection vector. Sanitize at ingest, or restrict the downstream
   * LLM's tool-use capabilities.
   */
  prompt(question: string, opts: QueryOptions & PromptContext = {}): string {
    const { questionDate, questionType, ...queryOpts } = opts;
    const result = this.query(question, queryOpts);
    return buildGraphPrompt(result.subgraph.serialized, question, {
      questionDate,
      questionType,
    });
  }

  // --- Index rebuild ---------------------------------------------------------

  /**
   * Reconstruct the TF-IDF index from the content of all existing nodes.
   *
   * Call this after `loadGai()` or `loadSqlite()` / `loadSqliteByName()` before
   * issuing `query()` calls. It is called automatically by those load methods,
   * so you only need this if you have mutated the graph manually.
   *
   * The operation is O(total token count across all nodes) — typically
   * under a few hundred milliseconds for graphs with < 50k nodes.
   */
  rebuildIndex(): void {
    const g = this.graph;
    // Enforce analyzer compatibility against the saved metadata. v0.1
    // Every v0.2+ graph stamps `analyzerAdapterId` on save. Missing →
    // assume the current default so the freshly-built index gets the
    // matching id stamped back on the metadata in this method.
    const savedAdapterId = g.metadata?.analyzerAdapterId ?? this.analyzer.id;
    if (savedAdapterId !== this.analyzer.id) {
      throw new AnalyzerMismatchError(savedAdapterId, this.analyzer.id);
    }
    // Stamp the metadata so re-saves preserve the adapter id even if
    // this graph was loaded from a v0.1 file.
    if (!g.metadata.analyzerAdapterId) g.metadata.analyzerAdapterId = this.analyzer.id;
    const index = createTfidfIndex(this.analyzer);
    for (const [id, node] of g.nodes) {
      if (node.type === 'document' || node.type === 'section') continue;
      addDocument(index, id, node.content);
    }
    computeIdf(index);
    (g as BuiltGraph).tfidfIndex = index;
  }

  // --- Persistence ----------------------------------------------------------

  /**
   * Serialize the graph to .gai binary and write it to disk.
   *
   * SECURITY: pass `hmacKey` for any file that will cross a trust boundary
   * (shared storage, network transfer, multi-tenant DB). Without it the
   * trailer is an additive checksum only — trivially forgeable.
   * WARNING: `filePath` is forwarded to `fs.writeFileSync` unchanged. Do
   * not pass user-controlled paths.
   */
  saveGai(filePath: string, opts: WriteGaiOptions = {}): void {
    writeFileSync(filePath, this.toBuffer(opts));
  }

  /**
   * Serialize the graph to a .gai-format `Buffer` without touching the
   * filesystem. Designed for serverless / edge runtimes (Vercel, Lambda,
   * Cloudflare Workers, Fly Machines) where writing to `/tmp` and reading
   * back is wasteful or unavailable.
   *
   * ```ts
   * const buf = g.toBuffer({ hmacKey });
   * await blobStore.put('knowledge.gai', buf);
   * ```
   *
   * SECURITY: pass `hmacKey` for any buffer that will cross a trust
   * boundary. Without it the trailer is an additive checksum only —
   * trivially forgeable.
   */
  toBuffer(opts: WriteGaiOptions = {}): Buffer {
    return writeGai(this.graph, opts);
  }

  /**
   * Load a .gai file and replace the current graph. The TF-IDF index is
   * automatically rebuilt from node content so `query()` works immediately.
   *
   * SECURITY: if the file was written with `hmacKey`, the same key must be
   * supplied here. Fail-closed: a missing key (or a key against an
   * unsigned file — a downgrade attempt) throws.
   */
  loadGai(filePath: string, opts: ReadGaiOptions = {}): KnowledgeGraph {
    return this.fromBuffer(readFileSync(filePath), opts);
  }

  /**
   * Load a .gai-format `Buffer` (e.g. read from blob storage) and replace
   * the current graph. The TF-IDF index is automatically rebuilt so
   * `query()` works immediately.
   *
   * SECURITY: same fail-closed semantics as `loadGai` — a buffer signed
   * with `hmacKey` requires the same key here, and a missing-key /
   * mismatched-key load throws.
   */
  fromBuffer(buf: Buffer, opts: ReadGaiOptions = {}): KnowledgeGraph {
    const { graph } = readGai(buf, opts);
    this.built = graph as BuiltGraph;
    this.documents = [];
    this.rebuildIndex();
    return graph;
  }

  /**
   * Persist the current graph to a SQLite database file.
   *
   * WARNING: `dbPath` is forwarded to better-sqlite3 unchanged. Do not pass
   * user-controlled paths. Requires the optional `better-sqlite3` dependency
   * to be installed.
   */
  saveSqlite(dbPath: string): void {
    const store = openSqliteStore(dbPath);
    try { store.saveGraph(this.graph); } finally { store.close(); }
  }

  /**
   * Persist the graph to a fresh SQLite database and return the database
   * file as a `Buffer`. Designed for serverless consumers who need to
   * upload the database to blob storage (S3, Vercel Blob, R2) without a
   * persistent local volume.
   *
   * INTERNAL TMPFILE: better-sqlite3 is fd-based, so this writes a
   * transient file under `os.tmpdir()` and reads it back. Containers
   * with a read-only root filesystem must mount `/tmp` writable.
   *
   * ```ts
   * const buf = g.toSqliteBuffer();
   * await blob.put('graphs/myorg/kg.sqlite', buf);
   * ```
   */
  toSqliteBuffer(): Buffer {
    const dir = mkdtempSync(join(tmpdir(), 'graphnosis-sqlite-'));
    const path = join(dir, 'graph.db');
    try {
      const store = openSqliteStore(path);
      try { store.saveGraph(this.graph); } finally { store.close(); }
      return readFileSync(path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /**
   * Load a graph by id from a SQLite database file. The TF-IDF index is
   * automatically rebuilt so `query()` works immediately after loading.
   *
   * WARNING: `dbPath` is forwarded to better-sqlite3 unchanged. Do not pass
   * user-controlled paths. Requires the optional `better-sqlite3` dependency
   * to be installed.
   */
  loadSqlite(dbPath: string, graphId: string): KnowledgeGraph | null {
    const store = openSqliteStore(dbPath);
    try {
      const g = store.loadGraph(graphId);
      if (g) {
        this.built = g as BuiltGraph;
        this.documents = [];
        this.rebuildIndex();
      }
      return g;
    } finally {
      store.close();
    }
  }

  /**
   * Load the most recently updated graph with the given **name** from a SQLite
   * database file. This is the stable reload path across process restarts —
   * use the same `name` you passed to `new Graphnosis({ name })` or `build()`.
   *
   * ```ts
   * // Process A — build and save
   * const g = new Graphnosis({ name: 'my-docs' });
   * g.addMarkdown(content, 'readme.md').build();
   * g.saveSqlite('./data/kg.db');
   *
   * // Process B — cold reload
   * const g2 = new Graphnosis();
   * g2.loadSqliteByName('./data/kg.db', 'my-docs');
   * const ctx = g2.query('how does chunking work?'); // works ✓
   * ```
   *
   * Returns `null` if no graph with that name exists. The TF-IDF index is
   * automatically rebuilt so `query()` works immediately after loading.
   */
  loadSqliteByName(dbPath: string, graphName: string): KnowledgeGraph | null {
    const store = openSqliteStore(dbPath);
    try {
      const g = store.loadGraphByName(graphName);
      if (g) {
        this.built = g as BuiltGraph;
        this.documents = [];
        this.rebuildIndex();
      }
      return g;
    } finally {
      store.close();
    }
  }

  /**
   * Load a SQLite database from a `Buffer` (e.g. fetched from blob
   * storage) and replace the current graph. If `graphName` is provided,
   * the most recently updated graph with that name is loaded; otherwise
   * the first graph in the database is loaded.
   *
   * INTERNAL TMPFILE: same caveat as `toSqliteBuffer` — writes a
   * transient file under `os.tmpdir()`.
   *
   * Returns `null` if no matching graph is found.
   */
  fromSqliteBuffer(buf: Buffer, graphName?: string): KnowledgeGraph | null {
    const dir = mkdtempSync(join(tmpdir(), 'graphnosis-sqlite-'));
    const path = join(dir, 'graph.db');
    try {
      writeFileSync(path, buf);
      const store = openSqliteStore(path);
      try {
        const g = graphName ? store.loadGraphByName(graphName) : store.loadGraphByName(this.name);
        if (g) {
          this.built = g as BuiltGraph;
          this.documents = [];
          this.rebuildIndex();
        }
        return g;
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // --- Full-graph consistency check -----------------------------------------

  /**
   * Run the reflection engine over the entire graph. Returns contradictions,
   * surprising cross-domain connections, decayed nodes, and inferred edges.
   *
   * Use this periodically (e.g. after a batch of appends) for a full
   * consistency audit. For real-time per-append checks use the
   * `contradictions` field in the `AppendResult` returned by `append*()`.
   */
  reflect(): ReflectionResult {
    return reflect(this.graph, this.graph.tfidfIndex);
  }

  // --- Corrections -----------------------------------------------------------

  /**
   * Apply a single correction to the graph. Prefer the typed helpers
   * (`edit`, `deleteNode`, `supersede`) for most use-cases; use `correct`
   * directly when you have a pre-built `Correction` object (e.g. from bulk
   * import or a serialized queue).
   *
   * Corrections are soft operations — nodes are never hard-deleted. A deleted
   * or superseded node has its `confidence` set to 0.1 and `validUntil` set
   * to the current timestamp so it drops out of query results while remaining
   * auditable.
   */
  correct(correction: Correction): CorrectionResult {
    const g = this.graph;
    const result = applyCorrection(g, g.tfidfIndex, correction);
    return {
      applied: result.success ? 1 : 0,
      nodesAdded: correction.type === 'add' && result.success ? 1 : 0,
      nodesModified: correction.type === 'edit' && result.success ? 1 : 0,
      nodesSuperseded: correction.type === 'supersede' && result.success ? 1 : 0,
      errors: result.error ? [result.error] : [],
    };
  }

  /**
   * Edit the content of an existing node in-place.
   *
   * @param nodeId  The id of the node to update.
   * @param content The replacement content.
   * @param reason  Human-readable reason (stored on the node for audit).
   */
  edit(nodeId: string, content: string, reason: string): CorrectionResult {
    return this.correct({ type: 'edit', nodeId, content, reason, timestamp: Date.now() });
  }

  /**
   * Soft-delete a node. The node is retained for audit purposes but its
   * confidence drops to 0.1 and `validUntil` is set to now, so it will not
   * appear in query results.
   *
   * Named `deleteNode` to avoid shadowing the built-in `delete` operator.
   */
  deleteNode(nodeId: string, reason: string): CorrectionResult {
    return this.correct({ type: 'delete', nodeId, reason, timestamp: Date.now() });
  }

  /**
   * Supersede a node with new content. The old node is soft-deleted and a new
   * node is created with the replacement content, linked via a `supersedes`
   * directed edge so the lineage is auditable.
   */
  supersede(nodeId: string, content: string, reason: string): CorrectionResult {
    return this.correct({ type: 'supersede', nodeId, content, reason, timestamp: Date.now() });
  }

  /**
   * Ingest a markdown document as a batch of corrections (each chunk becomes
   * a new node). Useful for bulk-importing curated knowledge patches.
   */
  importMarkdown(content: string, sourceLabel: string): CorrectionResult {
    return importCorrections(this.graph, this.graph.tfidfIndex, content, sourceLabel);
  }

  /**
   * Forget all nodes whose `createdAt` timestamp falls before `beforeMs`.
   * Useful for GDPR / data-retention policies.
   * Returns the number of nodes soft-deleted.
   */
  forgetBefore(beforeMs: number, reason = 'system:retention-policy'): { forgotten: number } {
    return forgetByTimeWindow(this.graph, beforeMs, reason);
  }

  /**
   * Forget all nodes that match a topic (entity name or content keyword).
   * Uses the same entity + content matching as the query engine.
   * Returns the number of nodes soft-deleted.
   */
  forgetTopic(topic: string, reason = 'user:topic-deletion'): { forgotten: number } {
    return forgetByTopic(this.graph, topic, reason);
  }
}

// --- Multi-graph federation --------------------------------------------------

/**
 * Query multiple independent Graphnosis instances in parallel and merge their
 * subgraph results into a single ranked prompt.
 *
 * Each graph is queried independently with the same question. The scored nodes
 * from all subgraphs are collected, sorted by relevance score (descending),
 * deduplicated by content hash, and the top `maxNodes` are serialized into a
 * single prompt context block.
 *
 * **When to use:**
 * - You maintain separate knowledge graphs per domain, user, or data source
 *   and want to retrieve across all of them for a single query.
 * - You want to keep graphs isolated (different TTLs, access controls,
 *   persistence backends) but combine them at query time.
 *
 * **Security:** each graph is queried in-process — no network egress.
 *
 * @param graphs    Array of built Graphnosis instances to query.
 * @param question  The natural-language question.
 * @param opts      Standard QueryOptions applied to each graph independently.
 * @param maxNodes  Max nodes to include across all graphs (default 20).
 * @returns A merged prompt string ready to send to any LLM.
 */
export function queryGraphs(
  graphs: Graphnosis[],
  question: string,
  opts: QueryOptions & PromptContext = {},
  maxNodes = 20
): string {
  const { questionDate, questionType, ...queryOpts } = opts;

  // Collect scored nodes from all graphs
  const allNodes: Array<{ content: string; score: number; graphName: string }> = [];
  const seenHashes = new Set<string>();

  for (const g of graphs) {
    try {
      const result = g.query(question, queryOpts);
      const graphName = g.graph.name ?? 'graph';
      for (const node of result.subgraph.nodes) {
        if (seenHashes.has(node.contentHash)) continue; // cross-graph dedup
        seenHashes.add(node.contentHash);
        const score = result.seeds.find(s => s.nodeId === node.id)?.score ?? 0;
        allNodes.push({ content: node.content, score, graphName });
      }
    } catch {
      // Graph not built or empty — skip silently
    }
  }

  if (allNodes.length === 0) {
    return buildGraphPrompt('=== KNOWLEDGE SUBGRAPH (0 nodes) ===\nNo relevant nodes found.', question, { questionDate, questionType });
  }

  // Sort by score desc, take top N
  allNodes.sort((a, b) => b.score - a.score);
  const top = allNodes.slice(0, maxNodes);

  const serialized = [
    `=== FEDERATED KNOWLEDGE SUBGRAPH (${top.length} nodes across ${graphs.length} graphs) ===`,
    ...top.map((n, i) =>
      `[${i + 1}] [source:${n.graphName}] [score:${n.score.toFixed(3)}]\n${n.content}`
    ),
  ].join('\n\n');

  return buildGraphPrompt(serialized, question, { questionDate, questionType });
}

// --- Lower-level re-exports --------------------------------------------------
// Advanced callers can bypass the facade and compose the primitives directly.
// Intentionally NOT re-exported: `@/core/enrichment/*` and `@/core/query/answer.ts`
// — both perform network I/O (OpenAI). Keeping them out of the SDK surface is
// how the "no-egress" guarantee is maintained.

export { buildGraph, attachEmbeddings, type BuiltGraph } from '@/core/graph/graph-builder';
// Embedding helpers — opt-in network code path. See SECURITY INVARIANT #4.
export {
  createEmbeddingIndex,
  embedNodes,
  embedQuery,
  type EmbeddingIndex,
  type EmbeddingVector,
  type EmbedOptions,
} from '@/core/similarity/embeddings';
export type { EmbeddingAdapter } from '@/core/similarity/embedding-adapter';
// Built-in analyzers + the TextAnalyzer contract.
export {
  asciiFoldAnalyzer,
  unicodeAnalyzer,
  type TextAnalyzer,
} from '@/core/similarity/analyzer';
// Typed errors for branching without string-matching.
export {
  AnalyzerMismatchError,
  EmbeddingAdapterMismatchError,
} from '@/core/errors';
export { addDocumentsToGraph, type IncrementalResult } from '@/core/graph/incremental';
export { reflect, type ReflectionResult } from '@/core/optimization/reflection';
export {
  applyCorrection,
  importCorrections,
  forgetByTimeWindow,
  forgetByTopic,
  cascadeSoftDelete,
  type Correction,
  type CorrectionResult,
} from '@/core/corrections/correction-engine';
export {
  queryGraph,
  buildGraphPrompt,
  type QueryOptions,
  type PromptContext,
} from '@/core/query/query-engine';
export { parseMarkdown } from '@/core/ingestion/parsers/markdown-parser';
export { parseHtml } from '@/core/ingestion/parsers/html-parser';
export { parseCsv, parseJson } from '@/core/ingestion/parsers/csv-parser';
export { writeGai, type WriteGaiOptions } from '@/core/format/gai-writer';
export { readGai, type ReadGaiOptions, type GaiHeader } from '@/core/format/gai-reader';
export { openSqliteStore, type SqliteStore } from '@/core/persistence/sqlite-store';
export { toSerializable, fromSerializable } from '@/core/graph/graph-store';

// Type surface — the most useful types for end users.
export type {
  KnowledgeGraph,
  GraphNode,
  DirectedEdge,
  UndirectedEdge,
  ParsedDocument,
  ParsedSection,
  SubgraphContext,
  QueryResult,
  TfidfIndex,
  NodeType,
  NodeId,
  EdgeId,
  SourceReference,
} from '@/core/types';
