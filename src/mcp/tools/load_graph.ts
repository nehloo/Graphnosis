import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';
import { z } from 'zod';
import { readGai } from '@/core/format/gai-reader';
import { createSession } from '../graph-session';
import { buildTfidfFromGraph, getCached, setCached } from '../tfidf-cache';
import type { SessionGraph } from '../graph-session';

export const LoadGraphInput = z.object({
  path: z.string().describe('Absolute or ~ path to a .gai file'),
});

export type LoadGraphResult = {
  graphId: string;
  name: string;
  nodeCount: number;
  directedEdgeCount: number;
  undirectedEdgeCount: number;
};

export async function loadGraph(input: z.infer<typeof LoadGraphInput>): Promise<LoadGraphResult> {
  const absPath = expandPath(input.path);

  if (!existsSync(absPath)) {
    throw new Error(`File not found: ${absPath}`);
  }

  const buffer = readFileSync(absPath);
  const { graph, header } = readGai(buffer);

  // Rebuild TF-IDF (not stored in .gai). Use mtime-keyed cache for fast reloads.
  let tfidfIndex = getCached(absPath);
  if (!tfidfIndex) {
    tfidfIndex = buildTfidfFromGraph(graph);
    setCached(absPath, tfidfIndex);
  }

  const session: SessionGraph = { ...graph, tfidfIndex };
  const graphId = createSession(session);

  return {
    graphId,
    name: header.name,
    nodeCount: header.nodeCount,
    directedEdgeCount: header.directedEdgeCount,
    undirectedEdgeCount: header.undirectedEdgeCount,
  };
}

export function expandPath(p: string): string {
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  return resolve(p);
}
