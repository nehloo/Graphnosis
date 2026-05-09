import type Database from 'better-sqlite3';
import type {
  KnowledgeGraph,
  GraphNode,
  DirectedEdge,
  UndirectedEdge,
  SerializableGraph,
  NodeId,
} from '@/core/types';
import { fromSerializable, toSerializable } from '@/core/graph/graph-store';
import path from 'path';

const DB_PATH = path.join(process.cwd(), 'data', 'graphnosis.db');

// Lazy-load better-sqlite3 so it can be listed as an optional dependency. The
// import fails loudly only when a persistence call is actually attempted.
// `eval('require')` works in both the Next.js ESM build and the SDK's
// CommonJS build without tsc trying to transform it.
let DatabaseCtor: typeof import('better-sqlite3') | null = null;
function loadDatabase(): typeof import('better-sqlite3') {
  if (DatabaseCtor) return DatabaseCtor;
  try {
    const req = eval('require') as NodeRequire;
    DatabaseCtor = req('better-sqlite3') as typeof import('better-sqlite3');
    return DatabaseCtor;
  } catch {
    throw new Error(
      '[graphnosis] SQLite persistence requires better-sqlite3. ' +
        'Install it with: npm install better-sqlite3'
    );
  }
}

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!db) {
    const Database = loadDatabase();
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema(db);
  }
  return db;
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS graphs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      levels INTEGER NOT NULL DEFAULT 1,
      metadata TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      graph_id TEXT NOT NULL,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      type TEXT NOT NULL,
      source TEXT NOT NULL,
      entities TEXT NOT NULL,
      metadata TEXT NOT NULL,
      level INTEGER NOT NULL DEFAULT 0,
      confidence REAL NOT NULL DEFAULT 0.9,
      created_at INTEGER NOT NULL,
      last_accessed_at INTEGER NOT NULL,
      access_count INTEGER NOT NULL DEFAULT 0,
      valid_until INTEGER,
      FOREIGN KEY (graph_id) REFERENCES graphs(id)
    );

    CREATE TABLE IF NOT EXISTS directed_edges (
      id TEXT PRIMARY KEY,
      graph_id TEXT NOT NULL,
      from_node TEXT NOT NULL,
      to_node TEXT NOT NULL,
      type TEXT NOT NULL,
      weight REAL NOT NULL,
      evidence TEXT,
      created_at INTEGER,
      FOREIGN KEY (graph_id) REFERENCES graphs(id)
    );

    CREATE TABLE IF NOT EXISTS undirected_edges (
      id TEXT PRIMARY KEY,
      graph_id TEXT NOT NULL,
      node_a TEXT NOT NULL,
      node_b TEXT NOT NULL,
      type TEXT NOT NULL,
      weight REAL NOT NULL,
      created_at INTEGER,
      FOREIGN KEY (graph_id) REFERENCES graphs(id)
    );

    CREATE INDEX IF NOT EXISTS idx_nodes_graph ON nodes(graph_id);
    CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type);
    CREATE INDEX IF NOT EXISTS idx_nodes_hash ON nodes(content_hash);
    CREATE INDEX IF NOT EXISTS idx_directed_graph ON directed_edges(graph_id);
    CREATE INDEX IF NOT EXISTS idx_directed_from ON directed_edges(from_node);
    CREATE INDEX IF NOT EXISTS idx_directed_to ON directed_edges(to_node);
    CREATE INDEX IF NOT EXISTS idx_undirected_graph ON undirected_edges(graph_id);
  `);
}

// Save a graph to SQLite
export function saveGraph(graph: KnowledgeGraph): void {
  const d = getDb();
  const serializable = toSerializable(graph);

  const saveOp = d.transaction(() => {
    // Upsert graph record
    d.prepare(`
      INSERT OR REPLACE INTO graphs (id, name, levels, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      graph.id,
      graph.name,
      graph.levels,
      JSON.stringify(graph.metadata),
      graph.metadata.createdAt,
      Date.now()
    );

    // Clear existing nodes/edges for this graph (full save)
    d.prepare('DELETE FROM nodes WHERE graph_id = ?').run(graph.id);
    d.prepare('DELETE FROM directed_edges WHERE graph_id = ?').run(graph.id);
    d.prepare('DELETE FROM undirected_edges WHERE graph_id = ?').run(graph.id);

    // Insert nodes
    const insertNode = d.prepare(`
      INSERT INTO nodes (id, graph_id, content, content_hash, type, source, entities, metadata, level, confidence, created_at, last_accessed_at, access_count, valid_until)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const node of serializable.nodes) {
      insertNode.run(
        node.id, graph.id, node.content, node.contentHash, node.type,
        JSON.stringify(node.source), JSON.stringify(node.entities),
        JSON.stringify(node.metadata), node.level, node.confidence,
        node.createdAt || Date.now(), node.lastAccessedAt || Date.now(),
        node.accessCount || 0, node.validUntil || null
      );
    }

    // Insert directed edges
    const insertDirected = d.prepare(`
      INSERT INTO directed_edges (id, graph_id, from_node, to_node, type, weight, evidence, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const edge of serializable.directedEdges) {
      insertDirected.run(
        edge.id, graph.id, edge.from, edge.to, edge.type,
        edge.weight, edge.evidence || null, edge.createdAt || Date.now()
      );
    }

    // Insert undirected edges
    const insertUndirected = d.prepare(`
      INSERT INTO undirected_edges (id, graph_id, node_a, node_b, type, weight, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const edge of serializable.undirectedEdges) {
      insertUndirected.run(
        edge.id, graph.id, edge.nodes[0], edge.nodes[1], edge.type,
        edge.weight, edge.createdAt || Date.now()
      );
    }
  });

  saveOp();
}

// Load a graph from SQLite by name (most recently updated wins)
export function loadGraphByName(graphName: string): KnowledgeGraph | null {
  const d = getDb();
  const row = d.prepare(
    'SELECT id FROM graphs WHERE name = ? ORDER BY updated_at DESC LIMIT 1'
  ).get(graphName) as { id: string } | undefined;
  if (!row) return null;
  return loadGraph(row.id);
}

// Load a graph from SQLite
export function loadGraph(graphId: string): KnowledgeGraph | null {
  const d = getDb();

  const graphRow = d.prepare('SELECT * FROM graphs WHERE id = ?').get(graphId) as {
    id: string; name: string; levels: number; metadata: string;
  } | undefined;

  if (!graphRow) return null;

  const nodes = d.prepare('SELECT * FROM nodes WHERE graph_id = ?').all(graphId) as Array<{
    id: string; content: string; content_hash: string; type: string;
    source: string; entities: string; metadata: string; level: number;
    confidence: number; created_at: number; last_accessed_at: number;
    access_count: number; valid_until: number | null;
  }>;

  const directedEdges = d.prepare('SELECT * FROM directed_edges WHERE graph_id = ?').all(graphId) as Array<{
    id: string; from_node: string; to_node: string; type: string;
    weight: number; evidence: string | null; created_at: number | null;
  }>;

  const undirectedEdges = d.prepare('SELECT * FROM undirected_edges WHERE graph_id = ?').all(graphId) as Array<{
    id: string; node_a: string; node_b: string; type: string;
    weight: number; created_at: number | null;
  }>;

  const serializable: SerializableGraph = {
    id: graphRow.id,
    name: graphRow.name,
    levels: graphRow.levels,
    metadata: JSON.parse(graphRow.metadata),
    nodes: nodes.map(n => ({
      id: n.id,
      content: n.content,
      contentHash: n.content_hash,
      type: n.type as GraphNode['type'],
      source: JSON.parse(n.source),
      entities: JSON.parse(n.entities),
      metadata: JSON.parse(n.metadata),
      level: n.level,
      confidence: n.confidence,
      createdAt: n.created_at,
      lastAccessedAt: n.last_accessed_at,
      accessCount: n.access_count,
      validUntil: n.valid_until || undefined,
    })),
    directedEdges: directedEdges.map(e => ({
      id: e.id,
      from: e.from_node,
      to: e.to_node,
      type: e.type as DirectedEdge['type'],
      weight: e.weight,
      evidence: e.evidence || undefined,
      createdAt: e.created_at || undefined,
    })),
    undirectedEdges: undirectedEdges.map(e => ({
      id: e.id,
      nodes: [e.node_a, e.node_b] as [string, string],
      type: e.type as UndirectedEdge['type'],
      weight: e.weight,
      createdAt: e.created_at || undefined,
    })),
  };

  return fromSerializable(serializable);
}

// List all saved graphs
export function listGraphs(): Array<{ id: string; name: string; nodeCount: number; updatedAt: number }> {
  const d = getDb();
  const rows = d.prepare('SELECT id, name, metadata, updated_at FROM graphs ORDER BY updated_at DESC').all() as Array<{
    id: string; name: string; metadata: string; updated_at: number;
  }>;

  return rows.map(r => {
    const meta = JSON.parse(r.metadata);
    return {
      id: r.id,
      name: r.name,
      nodeCount: meta.nodeCount || 0,
      updatedAt: r.updated_at,
    };
  });
}

// Update access stats when a node is queried
export function recordNodeAccess(graphId: string, nodeIds: NodeId[]): void {
  const d = getDb();
  const stmt = d.prepare(`
    UPDATE nodes SET last_accessed_at = ?, access_count = access_count + 1
    WHERE id = ? AND graph_id = ?
  `);
  const now = Date.now();
  const update = d.transaction(() => {
    for (const nodeId of nodeIds) {
      stmt.run(now, nodeId, graphId);
    }
  });
  update();
}

// Close the database connection
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// --- External (SDK) entrypoint -------------------------------------------------
// Open a store bound to an explicit DB path. The process-cwd default above is
// retained for the Next.js app; SDK callers go through this factory so they
// don't inherit cwd and don't share the module-level singleton.
export interface SqliteStore {
  saveGraph(graph: KnowledgeGraph): void;
  loadGraph(graphId: string): KnowledgeGraph | null;
  loadGraphByName(graphName: string): KnowledgeGraph | null;
  listGraphs(): Array<{ id: string; name: string; nodeCount: number; updatedAt: number }>;
  recordNodeAccess(graphId: string, nodeIds: NodeId[]): void;
  close(): void;
}

export function openSqliteStore(dbPath: string): SqliteStore {
  const Database = loadDatabase();
  const handle = new Database(dbPath);
  handle.pragma('journal_mode = WAL');
  handle.pragma('foreign_keys = ON');
  initSchema(handle);

  const withSingleton = <T>(fn: () => T): T => {
    const prev = db;
    db = handle;
    try { return fn(); } finally { db = prev; }
  };

  return {
    saveGraph: (graph) => withSingleton(() => saveGraph(graph)),
    loadGraph: (id) => withSingleton(() => loadGraph(id)),
    loadGraphByName: (name) => withSingleton(() => loadGraphByName(name)),
    listGraphs: () => withSingleton(() => listGraphs()),
    recordNodeAccess: (graphId, nodeIds) => withSingleton(() => recordNodeAccess(graphId, nodeIds)),
    close: () => handle.close(),
  };
}
