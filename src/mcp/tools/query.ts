import { z } from 'zod';
import { queryGraph } from '@/core/query/query-engine';
import { getSession, getDefaultSession } from '../graph-session';

export const QueryInput = z.object({
  question: z.string().min(1).describe('Natural-language question to answer from the graph'),
  graphId: z.string().optional().describe('Session graph ID (omit to use the most-recently loaded graph)'),
  maxNodes: z.number().int().min(1).max(100).optional().describe('Max nodes in subgraph (default 20)'),
});

export type QueryResult = {
  // Plain-text subgraph snippet ready for injection into an LLM system prompt.
  // This is the ONLY graph data returned — the full graph never leaves the session.
  serialized: string;
  nodeCount: number;
};

export async function query(input: z.infer<typeof QueryInput>): Promise<QueryResult> {
  const session = input.graphId ? getSession(input.graphId) : getDefaultSession();

  if (!session) {
    throw new Error('No graph loaded. Call load_graph or ingest_files first.');
  }

  const result = queryGraph(session, session.tfidfIndex, input.question, {
    maxNodes: input.maxNodes ?? 20,
  });

  return {
    serialized: result.subgraph.serialized,
    nodeCount: result.subgraph.nodes.length,
  };
}
