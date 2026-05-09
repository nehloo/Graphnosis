/**
 * Graphnosis MCP Server
 *
 * Mode 1 (stdio, default): started by Claude Code / Claude Desktop via claude_desktop_config.json
 *   MCP_TRANSPORT unset → stdio
 *
 * Mode 2 (HTTP, enterprise): run inside Docker, exposes port MCP_PORT (default 3001)
 *   MCP_TRANSPORT=http → StreamableHTTP on express
 *
 * Example claude_desktop_config.json entry (Mode 1):
 *   {
 *     "mcpServers": {
 *       "graphnosis": {
 *         "command": "node",
 *         "args": ["node_modules/.bin/tsx", "src/mcp/server.ts"],
 *         "cwd": "/path/to/Graphnosis"
 *       }
 *     }
 *   }
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { loadGraph, LoadGraphInput } from './tools/load_graph.js';
import { ingestFiles, IngestFilesInput } from './tools/ingest_files.js';
import { updateGraph, UpdateGraphInput } from './tools/update_graph.js';
import { query, QueryInput } from './tools/query.js';
import { exportGraph, ExportInput } from './tools/export.js';

const server = new McpServer(
  { name: 'graphnosis', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

// ── Tool: load_graph ──────────────────────────────────────────────────────────
server.tool(
  'load_graph',
  'Load a .gai knowledge graph file into the session. Returns a graphId for use in subsequent calls.',
  LoadGraphInput.shape,
  async (args: z.infer<typeof LoadGraphInput>) => {
    const result = await loadGraph(args);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(result),
        },
      ],
    };
  }
);

// ── Tool: ingest_files ────────────────────────────────────────────────────────
server.tool(
  'ingest_files',
  'Parse local files (md, txt, html, pdf, csv) and build a new knowledge graph. Returns a graphId.',
  IngestFilesInput.shape,
  async (args: z.infer<typeof IngestFilesInput>) => {
    const result = await ingestFiles(args);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(result),
        },
      ],
    };
  }
);

// ── Tool: update_graph ────────────────────────────────────────────────────────
server.tool(
  'update_graph',
  'Incrementally add new files to an existing graph session. Optionally persist back to a .gai file.',
  UpdateGraphInput.shape,
  async (args: z.infer<typeof UpdateGraphInput>) => {
    const result = await updateGraph(args);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(result),
        },
      ],
    };
  }
);

// ── Tool: query ───────────────────────────────────────────────────────────────
server.tool(
  'query',
  'Query the knowledge graph with a natural-language question. Returns a plain-text subgraph snippet (~2K tokens) suitable for injection into an LLM system prompt. Only the relevant subgraph is returned — the full graph never leaves the session.',
  QueryInput.shape,
  async (args: z.infer<typeof QueryInput>) => {
    const result = await query(args);
    return {
      content: [
        {
          type: 'text' as const,
          text: result.serialized,
        },
      ],
    };
  }
);

// ── Tool: export ──────────────────────────────────────────────────────────────
server.tool(
  'export',
  'Write the current graph session to a .gai file on disk.',
  ExportInput.shape,
  async (args: z.infer<typeof ExportInput>) => {
    const result = await exportGraph(args);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(result),
        },
      ],
    };
  }
);

// ── Transport ─────────────────────────────────────────────────────────────────
async function main() {
  const transport = process.env.MCP_TRANSPORT === 'http' ? await startHttp() : new StdioServerTransport();
  await server.connect(transport);
}

async function startHttp() {
  // Dynamic import so express is only loaded in Mode 2
  const express = (await import('express')).default;
  const { randomUUID } = await import('crypto');

  const app = express();
  app.use(express.json());

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });

  app.all('/mcp', (req, res) => {
    transport.handleRequest(req, res, req.body);
  });

  const port = parseInt(process.env.MCP_PORT ?? '3001', 10);
  app.listen(port, () => {
    process.stderr.write(`[graphnosis-mcp] HTTP transport listening on port ${port}\n`);
  });

  return transport;
}

main().catch(err => {
  process.stderr.write(`[graphnosis-mcp] Fatal: ${err}\n`);
  process.exit(1);
});
