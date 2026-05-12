import { readFileSync, writeFileSync, existsSync } from 'fs';
import { extname, resolve } from 'path';
import { homedir } from 'os';
import { z } from 'zod';
import { addDocumentsToGraph } from '@/core/graph/incremental';
import { writeGai } from '@/core/format/gai-writer';
import { parseMarkdown } from '@/core/ingestion/parsers/markdown-parser';
import { parseHtml } from '@/core/ingestion/parsers/html-parser';
import { parseCsv } from '@/core/ingestion/parsers/csv-parser';
import { parsePdf } from '@/core/ingestion/parsers/pdf-parser';
import type { ParsedDocument } from '@/core/types';
import { getSession, getDefaultSession, getDefaultSessionId, setSession } from '../graph-session';
import { setCached } from '../tfidf-cache';

export const UpdateGraphInput = z.object({
  files: z.array(z.string()).min(1).describe('Files to add to the existing graph'),
  graphId: z.string().optional().describe('Session graph ID (omit to use the most-recently loaded graph)'),
  outputPath: z.string().optional().describe('If provided, write the updated graph back to this .gai path'),
});

export type UpdateGraphResult = {
  newNodes: number;
  newDirectedEdges: number;
  newUndirectedEdges: number;
  totalNodes: number;
  savedTo?: string;
};

export async function updateGraph(input: z.infer<typeof UpdateGraphInput>): Promise<UpdateGraphResult> {
  const session = input.graphId ? getSession(input.graphId) : getDefaultSession();
  const sessionId = input.graphId ?? getDefaultSessionId();

  if (!session) {
    throw new Error('No graph loaded. Call load_graph or ingest_files first.');
  }

  const documents: ParsedDocument[] = [];
  const skipped: string[] = [];

  for (const rawPath of input.files) {
    const absPath = expandPath(rawPath);
    if (!existsSync(absPath)) {
      skipped.push(`${rawPath} (not found)`);
      continue;
    }
    try {
      const ext = extname(absPath).toLowerCase();
      const doc = await parseFile(absPath, ext);
      if (doc) documents.push(doc);
      else skipped.push(`${rawPath} (unsupported)`);
    } catch (err) {
      skipped.push(`${rawPath} (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  if (documents.length === 0) {
    throw new Error(`No files could be parsed. Skipped: ${skipped.join(', ')}`);
  }

  const result = addDocumentsToGraph(session, documents);

  // Persist updated TF-IDF back into the session (addDocumentsToGraph mutates session.tfidfIndex)
  if (sessionId) setSession(sessionId, session);

  let savedTo: string | undefined;
  if (input.outputPath) {
    const absOut = expandPath(input.outputPath);
    const buf = writeGai(session);
    writeFileSync(absOut, buf);
    setCached(absOut, session.tfidfIndex);
    savedTo = absOut;
  }

  return {
    newNodes: result.newNodes,
    newDirectedEdges: result.newDirectedEdges,
    newUndirectedEdges: result.newUndirectedEdges,
    totalNodes: session.nodes.size,
    savedTo,
  };
}

async function parseFile(absPath: string, ext: string): Promise<ParsedDocument | null> {
  switch (ext) {
    case '.md':
    case '.markdown':
    case '.txt': {
      const content = readFileSync(absPath, 'utf-8');
      return parseMarkdown(content, absPath);
    }
    case '.html':
    case '.htm': {
      const content = readFileSync(absPath, 'utf-8');
      return parseHtml(content, absPath);
    }
    case '.csv': {
      const content = readFileSync(absPath, 'utf-8');
      return parseCsv(content, absPath);
    }
    case '.pdf': {
      const buffer = readFileSync(absPath);
      return parsePdf(buffer, absPath);
    }
    default:
      return null;
  }
}

function expandPath(p: string): string {
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  return resolve(p);
}
