// Graphnosis SDK — public entrypoint for using Graphnosis as an NPM dependency.
//
// Wraps src/core/* into a small class-based facade that covers the common
// flow: ingest documents -> build a dual graph -> query for a subgraph -> save
// or load. Lower-level primitives are also re-exported at the bottom so
// advanced callers can compose them directly.

import { readFileSync, writeFileSync } from 'node:fs';
import type {
  KnowledgeGraph,
  ParsedDocument,
  SubgraphContext,
  TfidfIndex,
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
import { writeGai } from '@/core/format/gai-writer';
import { readGai } from '@/core/format/gai-reader';
import { openSqliteStore, type SqliteStore } from '@/core/persistence/sqlite-store';

export interface GraphnosisOptions {
  /** Name attached to the built graph. Defaults to "graphnosis". */
  name?: string;
}

/**
 * Ingests documents, builds a dual-graph, and answers questions against it.
 *
 * ```ts
 * import { Graphnosis } from 'graphnosis';
 *
 * const g = new Graphnosis({ name: 'docs' });
 * g.addMarkdown(readmeText, 'README.md');
 * g.build();
 *
 * const ctx = g.query('how does chunking work?');
 * console.log(ctx.serialized);
 * ```
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

  /** Build the LLM system prompt that wraps the subgraph context. */
  prompt(question: string, opts: QueryOptions & PromptContext = {}): string {
    const { questionDate, questionType, ...queryOpts } = opts;
    const result = this.query(question, queryOpts);
    return buildGraphPrompt(result.subgraph.serialized, question, {
      questionDate,
      questionType,
    });
  }

  // --- Persistence ----------------------------------------------------------

  /** Serialize the graph to .gai binary and write it to disk. */
  saveGai(filePath: string): void {
    writeFileSync(filePath, writeGai(this.graph));
  }

  /** Load a .gai file and replace the current graph. tfidfIndex is NOT restored. */
  loadGai(filePath: string): KnowledgeGraph {
    const buffer = readFileSync(filePath);
    const { graph } = readGai(buffer);
    // loadGai does not carry a tfidfIndex; callers should re-build if they
    // intend to query. We expose the raw graph so they can.
    this.built = graph as BuiltGraph;
    this.documents = [];
    return graph;
  }

  /** Persist the current graph to a SQLite database file. */
  saveSqlite(dbPath: string): void {
    const store = openSqliteStore(dbPath);
    try { store.saveGraph(this.graph); } finally { store.close(); }
  }

  /** Load a graph by id from a SQLite database file. */
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
export { writeGai } from '@/core/format/gai-writer';
export { readGai, type GaiHeader } from '@/core/format/gai-reader';
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
