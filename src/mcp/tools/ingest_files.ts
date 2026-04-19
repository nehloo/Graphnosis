import { readFileSync, existsSync } from 'fs';
import { extname, basename, resolve } from 'path';
import { homedir } from 'os';
import { z } from 'zod';
import { buildGraph } from '@/core/graph/graph-builder';
import { parseMarkdown } from '@/core/ingestion/parsers/markdown-parser';
import { parseHtml } from '@/core/ingestion/parsers/html-parser';
import { parseCsv } from '@/core/ingestion/parsers/csv-parser';
import { parsePdf } from '@/core/ingestion/parsers/pdf-parser';
import type { ParsedDocument } from '@/core/types';
import { createSession } from '../graph-session';
import type { SessionGraph } from '../graph-session';

export const IngestFilesInput = z.object({
  files: z.array(z.string()).min(1).describe('Absolute or ~ paths to files to ingest'),
  graphName: z.string().optional().describe('Name for the resulting graph (default: first filename)'),
});

export type IngestFilesResult = {
  graphId: string;
  name: string;
  nodeCount: number;
  directedEdgeCount: number;
  undirectedEdgeCount: number;
  skipped: string[];
};

export async function ingestFiles(input: z.infer<typeof IngestFilesInput>): Promise<IngestFilesResult> {
  const documents: ParsedDocument[] = [];
  const skipped: string[] = [];

  for (const rawPath of input.files) {
    const absPath = expandPath(rawPath);

    if (!existsSync(absPath)) {
      skipped.push(`${rawPath} (not found)`);
      continue;
    }

    const ext = extname(absPath).toLowerCase();

    try {
      const doc = await parseFile(absPath, ext);
      if (doc) documents.push(doc);
      else skipped.push(`${rawPath} (unsupported extension: ${ext})`);
    } catch (err) {
      skipped.push(`${rawPath} (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  if (documents.length === 0) {
    throw new Error(`No files could be parsed. Skipped: ${skipped.join(', ')}`);
  }

  const graphName = input.graphName ?? basename(input.files[0]);
  const builtGraph = buildGraph(documents, graphName);

  const session: SessionGraph = { ...builtGraph, tfidfIndex: builtGraph.tfidfIndex };
  const graphId = createSession(session);

  return {
    graphId,
    name: graphName,
    nodeCount: builtGraph.nodes.size,
    directedEdgeCount: builtGraph.directedEdges.size,
    undirectedEdgeCount: builtGraph.undirectedEdges.size,
    skipped,
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
