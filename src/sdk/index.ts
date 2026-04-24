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

import { readFileSync, writeFileSync } from 'node:fs';
import type {
  KnowledgeGraph,
  ParsedDocument,
  QueryResult,
} from '@/core/types';
import { buildGraph, type BuiltGraph } from '@/core/graph/graph-builder';
import { parseMarkdown } from '@/core/ingestion/parsers/markdown-parser';
import { parseHtml } from '@/core/ingestion/parsers/html-parser';
import { parseCsv, parseJson } from '@/core/ingestion/parsers/csv-parser';
import {
  queryGraph,
  buildGraphPrompt,
  type QueryOptions,
  type PromptContext,
} from '@/core/query/query-engine';
import { writeGai, type WriteGaiOptions } from '@/core/format/gai-writer';
import { readGai, type ReadGaiOptions } from '@/core/format/gai-reader';
import { openSqliteStore } from '@/core/persistence/sqlite-store';

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
}

// --- Lower-level re-exports --------------------------------------------------
// Advanced callers can bypass the facade and compose the primitives directly.
// Intentionally NOT re-exported: `@/core/enrichment/*` and `@/core/query/answer.ts`
// — both perform network I/O (OpenAI). Keeping them out of the SDK surface is
// how the "no-egress" guarantee is maintained.

export { buildGraph, type BuiltGraph } from '@/core/graph/graph-builder';
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
