import { nanoid } from 'nanoid';
import type { KnowledgeGraph, TfidfIndex } from '@/core/types';

export type SessionGraph = KnowledgeGraph & { tfidfIndex: TfidfIndex };

// In-process session store: graphId → loaded graph with TF-IDF index.
// Intentionally decoupled from the Next.js graph-store singleton.
const sessions = new Map<string, SessionGraph>();

export function createSession(graph: SessionGraph): string {
  const id = nanoid();
  sessions.set(id, graph);
  return id;
}

export function getSession(graphId: string): SessionGraph | undefined {
  return sessions.get(graphId);
}

// Returns the most-recently created session, useful when only one graph is loaded.
export function getDefaultSession(): SessionGraph | undefined {
  if (sessions.size === 0) return undefined;
  const ids = Array.from(sessions.keys());
  return sessions.get(ids[ids.length - 1]);
}

export function getDefaultSessionId(): string | undefined {
  if (sessions.size === 0) return undefined;
  const ids = Array.from(sessions.keys());
  return ids[ids.length - 1];
}

export function setSession(graphId: string, graph: SessionGraph): void {
  sessions.set(graphId, graph);
}

export function listSessions(): Array<{ id: string; name: string; nodeCount: number; directedEdgeCount: number }> {
  return Array.from(sessions.entries()).map(([id, g]) => ({
    id,
    name: g.name,
    nodeCount: g.nodes.size,
    directedEdgeCount: g.directedEdges.size,
  }));
}
