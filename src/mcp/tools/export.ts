import { writeFileSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';
import { z } from 'zod';
import { writeGai } from '@/core/format/gai-writer';
import { getSession, getDefaultSession } from '../graph-session';
import { setCached } from '../tfidf-cache';

export const ExportInput = z.object({
  outputPath: z.string().describe('Absolute or ~ path where the .gai file should be written'),
  graphId: z.string().optional().describe('Session graph ID (omit to use the most-recently loaded graph)'),
});

export type ExportResult = {
  path: string;
  sizeBytes: number;
  nodeCount: number;
};

export async function exportGraph(input: z.infer<typeof ExportInput>): Promise<ExportResult> {
  const session = input.graphId ? getSession(input.graphId) : getDefaultSession();

  if (!session) {
    throw new Error('No graph loaded. Call load_graph or ingest_files first.');
  }

  const absPath = expandPath(input.outputPath);
  const buf = writeGai(session);
  writeFileSync(absPath, buf);

  // Update the TF-IDF cache entry so subsequent load_graph calls benefit from it
  setCached(absPath, session.tfidfIndex);

  return {
    path: absPath,
    sizeBytes: buf.length,
    nodeCount: session.nodes.size,
  };
}

function expandPath(p: string): string {
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  return resolve(p);
}
