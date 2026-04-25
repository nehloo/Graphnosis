// Graphnosis SDK — public entrypoint for using Graphnosis as an NPM dependency.
//
// SECURITY INVARIANTS (enforced by what we re-export, not by runtime checks):
//   1. This module performs ZERO network I/O. No `fetch`, no HTTP client,
//      no SDK calls. It must not import from `@/core/enrichment/*` or from
//      `@/core/query/answer.ts` — both of those reach OpenAI. If you are
//      modifying this file, preserve that property. Enterprise adopters
//      verify the "no-egress" guarantee by auditing this file alone.
//   2. `.gai` files that cross a trust boundary must be written AND read
//      with `hmacKey`. The default additive checksum catches corruption,
//      NOT tampering.
//   3. File paths passed to `saveGai/loadGai/saveSqlite/loadSqlite` are
//      forwarded to `node:fs` and `better-sqlite3` as-is. Do NOT pass
//      user-controlled strings; canonicalize before calling.
//
// See `enterprise/enterprise.md` for the full IT/security posture.

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import type {
  KnowledgeGraph,
  ParsedDocument,
  QueryResult,
  Contradiction,
} from '@/core/types';
import { buildGraph, type BuiltGraph } from '@/core/graph/graph-builder';
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

  constructor(opts: GraphnosisOptions = {}) {
    this.name = opts.name ?? 'graphnosis';
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
    this.built = buildGraph(this.documents, this.name);
    return this.built;
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
    writeFileSync(filePath, writeGai(this.graph, opts));
  }

  /**
   * Load a .gai file and replace the current graph. `tfidfIndex` is NOT
   * restored; callers that intend to query a loaded graph should re-ingest
   * or call `build()` again from the source documents.
   *
   * SECURITY: if the file was written with `hmacKey`, the same key must be
   * supplied here. Fail-closed: a missing key (or a key against an
   * unsigned file — a downgrade attempt) throws.
   */
  loadGai(filePath: string, opts: ReadGaiOptions = {}): KnowledgeGraph {
    const buffer = readFileSync(filePath);
    const { graph } = readGai(buffer, opts);
    this.built = graph as BuiltGraph;
    this.documents = [];
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
   * Load a graph by id from a SQLite database file.
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
      }
      return g;
    } finally {
      store.close();
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
  forgetBefore(beforeMs: number, reason = 'data-retention'): { forgotten: number } {
    return forgetByTimeWindow(this.graph, beforeMs, reason);
  }

  /**
   * Forget all nodes that match a topic (entity name or content keyword).
   * Uses the same entity + content matching as the query engine.
   * Returns the number of nodes soft-deleted.
   */
  forgetTopic(topic: string, reason = 'user-request'): { forgotten: number } {
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

export { buildGraph, type BuiltGraph } from '@/core/graph/graph-builder';
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
