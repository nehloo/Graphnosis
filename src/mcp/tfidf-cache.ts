import { statSync } from 'fs';
import type { TfidfIndex } from '@/core/types';
import { createTfidfIndex, addDocument, computeIdf } from '@/core/similarity/tfidf';
import type { KnowledgeGraph } from '@/core/types';

interface CacheEntry {
  tfidfIndex: TfidfIndex;
  mtime: number;
}

// Keyed by absolute .gai path to avoid re-building TF-IDF on repeated loads
// of the same unchanged file.
const cache = new Map<string, CacheEntry>();

export function getCached(path: string): TfidfIndex | undefined {
  const entry = cache.get(path);
  if (!entry) return undefined;
  try {
    const { mtimeMs } = statSync(path);
    return mtimeMs === entry.mtime ? entry.tfidfIndex : undefined;
  } catch {
    return undefined;
  }
}

export function setCached(path: string, tfidfIndex: TfidfIndex): void {
  try {
    const { mtimeMs } = statSync(path);
    cache.set(path, { tfidfIndex, mtime: mtimeMs });
  } catch {
    // File may not exist yet (in-memory graph). No-op.
  }
}

// Rebuild TF-IDF from the loaded graph's nodes. Called after readGai since
// TF-IDF is not persisted in the .gai format.
export function buildTfidfFromGraph(graph: KnowledgeGraph): TfidfIndex {
  const index = createTfidfIndex();
  for (const node of graph.nodes.values()) {
    if (node.type === 'document' || node.type === 'section') continue;
    if (node.content && node.content.trim()) {
      addDocument(index, node.id, node.content);
    }
  }
  computeIdf(index);
  return index;
}
