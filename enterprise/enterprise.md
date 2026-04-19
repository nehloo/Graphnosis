# Graphnosis — Enterprise Deployment & Privacy Architecture

## The Core Privacy Guarantee

**The graph never leaves the enterprise.**

When you use Graphnosis with any LLM — Claude, GPT-4, Gemini, Ollama, Azure OpenAI, AWS Bedrock — only a small plain-text snippet (the subgraph relevant to the user's question, typically ~2,000 tokens) is ever sent to the LLM API. The `.gai` binary file, the full knowledge graph, all indexed nodes, and all edge data remain inside your machine or your enterprise network at all times.

This is not a configuration option. It is how the architecture works.

---

## What Gets Sent to the LLM

The `query` MCP tool extracts the 15–50 nodes most relevant to the user's question and serializes them as plain structured text. This snippet is injected into the LLM's system prompt — exactly the same as any instruction you would write manually:

```
=== KNOWLEDGE SUBGRAPH (15 nodes, 22 edges) ===

--- SESSION SUMMARIES ---
[n1|summary|0.91|session:abc|date:2023-05-15] User discussed coffee purchasing habits...
  claims: I bought 30 lbs of Ethiopian beans | I prefer light roast

--- NODES ---
[n2|fact|0.88|src:User (turn 3)|date:2023-05-15] I bought 30 lbs of coffee beans from the co-op
[n3|entity|0.74|src:Assistant (turn 4)] Ethiopian Yirgacheffe, a single-origin light roast

--- DIRECTED ---
n2 -[cites:0.8]-> n3
```

The LLM sees this as ordinary text. It does not know it came from a graph. No binary data is transmitted. No special LLM capability is required.

**What `query` returns to the caller:** only `serialized` (the plain-text snippet above) and `nodeCount`. The full graph, raw node list, edge collection, and `.gai` binary are never returned by any MCP tool.

---

## Privacy Architecture Diagram

```
Enterprise Perimeter
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  Raw files  ──►  Graphnosis  ──►  .gai  (stays internal)   │
│                                    ↓                        │
│  User query ──►  Query engine ──►  ~2K plain-text snippet   │
│                                                             │
└──────────────────────────┬──────────────────────────────────┘
                           │  LLM API call
                           │  system prompt includes snippet
                           ↓
              External or self-hosted LLM
              (Claude / GPT-4 / Gemini / Ollama / Azure / Bedrock)
              — sees ONLY the relevant subgraph text,
                never the full graph or .gai binary
```

**Data minimization by design:** only the output of `queryGraph` — at most 50 nodes, ~2K tokens of plain text — ever crosses the perimeter. The full graph, all other nodes, and the `.gai` file never do.

**Maximum privacy:** point `OPENAI_BASE_URL` at Ollama or another self-hosted model endpoint. No data leaves the enterprise at all. The LLM API call stays entirely inside the perimeter.

---

## Deployment: Enterprise On-Premises (Docker)

The enterprise deployment runs Graphnosis as a Docker container on your own infrastructure. It exposes an MCP endpoint over HTTP that any MCP-compatible client can connect to.

### Requirements

- Docker and Docker Compose
- A volume containing your `.gai` files (or an empty volume for fresh ingestion)
- An LLM API key or internal LLM gateway URL

### Quick start

```bash
# Clone the repository
git clone https://github.com/nehloo/Graphnosis
cd Graphnosis

# Configure environment
cp .env.example .env
# Edit .env: set OPENAI_API_KEY (or OPENAI_BASE_URL for internal gateway)
# Set GRAPH_DATA_PATH to the directory containing your .gai files

# Start the server
docker compose up -d

# MCP endpoint is now available at:
# http://your-internal-host:3001/mcp
```

### docker-compose.yml (included)

```yaml
services:
  graphnosis-mcp:
    build: .
    ports:
      - "${MCP_PORT:-3001}:3001"
    volumes:
      - "${GRAPH_DATA_PATH:-./data}:/data"
    environment:
      MCP_TRANSPORT: http
      MCP_PORT: 3001
      OPENAI_API_KEY: "${OPENAI_API_KEY}"
      OPENAI_BASE_URL: "${OPENAI_BASE_URL:-}"
    restart: unless-stopped
```

### Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | Yes (unless using Ollama) | API key for answer-generation calls (preference extraction, session summaries). Not used for graph construction. |
| `OPENAI_BASE_URL` | No | Override the OpenAI-compatible API endpoint — point at Azure OpenAI, AWS Bedrock proxy, or a self-hosted Ollama instance. |
| `MCP_TRANSPORT` | No (default: stdio) | Set to `http` for network transport (Docker / enterprise). |
| `MCP_PORT` | No (default: 3001) | Port for the HTTP MCP endpoint. |
| `GRAPH_DATA_PATH` | No (default: ./data) | Host path mounted as `/data` inside the container. Put `.gai` files here. |

---

## Using a Self-Hosted LLM (Ollama)

For maximum data isolation — no data leaves the enterprise at all — run Ollama alongside Graphnosis and point the API base URL at it:

```yaml
# docker-compose.yml addition
services:
  ollama:
    image: ollama/ollama
    volumes:
      - ollama_data:/root/.ollama
    ports:
      - "11434:11434"

  graphnosis-mcp:
    environment:
      OPENAI_BASE_URL: "http://ollama:11434/v1"
      OPENAI_API_KEY: "ollama"  # placeholder, required by the SDK
```

With this configuration, every LLM call — preference extraction, session summaries, and the final answer — stays inside the container network. Zero external API calls.

Graphnosis uses the OpenAI-compatible API (`/v1/chat/completions`). Any self-hosted model that implements this interface works: Ollama, vLLM, LM Studio, LocalAI, text-generation-webui with the OpenAI extension, and others.

---

## Using Azure OpenAI or AWS Bedrock

Both Azure OpenAI and AWS Bedrock expose OpenAI-compatible endpoints. Set `OPENAI_BASE_URL` to your deployment's base URL:

**Azure OpenAI:**
```bash
OPENAI_BASE_URL=https://your-resource.openai.azure.com/openai/deployments/your-deployment
OPENAI_API_KEY=your-azure-api-key
```

**AWS Bedrock (via a proxy like `bedrock-access-gateway`):**
```bash
OPENAI_BASE_URL=http://your-bedrock-proxy:8080/v1
OPENAI_API_KEY=your-bedrock-credentials
```

The graph construction pipeline (TF-IDF, chunking, entity extraction, edge building) is entirely local — zero LLM calls required. LLM calls are only made for optional features: session summary generation at ingest time, query-time preference extraction, and answer generation. All of these go through `OPENAI_BASE_URL`.

---

## Connecting MCP Clients

Any MCP-compatible client can connect to the HTTP endpoint. Examples:

**Claude Code (CLI):**
Add to your MCP server config:
```json
{
  "mcpServers": {
    "graphnosis": {
      "type": "http",
      "url": "http://your-internal-host:3001/mcp"
    }
  }
}
```

**Custom application (TypeScript):**
```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const client = new Client({ name: 'my-app', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(
  new URL('http://your-internal-host:3001/mcp')
));

// Load a graph
const loaded = await client.callTool({ name: 'load_graph', arguments: { path: '/data/knowledge.gai' } });

// Query it
const result = await client.callTool({
  name: 'query',
  arguments: { question: 'What did the user say about their coffee preferences?' }
});
// result.content[0].text contains only the plain-text subgraph snippet
```

---

## Security Considerations

### Network isolation

The Docker container exposes only port 3001. It makes no inbound connections. Outbound connections go only to:
- The LLM API endpoint (configurable via `OPENAI_BASE_URL`)
- No telemetry, no analytics, no external services

In a fully air-gapped deployment (Ollama), there are no external network calls at all.

### Authentication

The current MCP server does not implement authentication. For enterprise deployments, place the container behind your existing internal API gateway or reverse proxy (nginx, Traefik, Kong, etc.) to enforce:
- mTLS or bearer token authentication
- IP allowlisting
- Rate limiting
- Audit logging

### Data at rest

`.gai` files are binary (MessagePack + checksum). They are not encrypted at rest. If your security policy requires encryption at rest, mount an encrypted volume (LUKS, AWS EBS encryption, Azure Disk Encryption) as the `/data` volume.

### What Graphnosis stores

The server is stateless across restarts. Session graphs live in memory only — no database, no write-back unless you call `export`. The only persistent files are the `.gai` binaries on the mounted volume and an optional TF-IDF disk cache (also on the volume). No conversation content, query text, or LLM responses are stored by Graphnosis.

---

## LLM Compatibility

Graphnosis works with any LLM that accepts a system prompt. The subgraph snippet is plain text — no special model capability is required.

| LLM | Mode | Notes |
|-----|------|-------|
| Claude (Anthropic API) | API or Claude Desktop MCP | Native MCP support in Claude Desktop |
| GPT-4 / GPT-4o (OpenAI) | API | Default in run scripts |
| Gemini (Google AI) | API via OpenAI-compatible proxy | Use `litellm` or `openai-proxy` as shim |
| Ollama (self-hosted) | Local or Docker | Full air-gap support via `OPENAI_BASE_URL` |
| Azure OpenAI | Enterprise | Set `OPENAI_BASE_URL` to your deployment |
| AWS Bedrock | Enterprise | Use `bedrock-access-gateway` proxy |
| vLLM | Self-hosted | OpenAI-compatible, set `OPENAI_BASE_URL` |
| LM Studio | Local | OpenAI-compatible server on port 1234 |

The graph construction pipeline (TF-IDF, BFS traversal, subgraph serialization) is fully local for all deployments. LLM calls are made only for: session summary generation (optional, at ingest), query-time preference extraction (optional, per question type), and the final answer generation.

---

## Compliance Notes

**Data residency:** The `.gai` file and all indexed knowledge never leave the volume you control. Only the per-query subgraph snippet (plain text, max ~2K tokens) is sent to the LLM endpoint. If your LLM endpoint is self-hosted (Ollama, vLLM) or a region-locked cloud deployment (Azure EU regions, AWS GovCloud), all data processing can be constrained to a specific geographic region or network boundary.

**Audit trail:** Every node in the graph carries `createdAt`, `lastAccessedAt`, and `accessCount` metadata. The `.gai` format includes a checksum for integrity verification. Corrections are soft-delete only — no knowledge is permanently destroyed, making the graph fully auditable.

**Open source:** The full codebase is MIT-licensed and auditable. No proprietary components, no binary blobs, no vendor lock-in. The `.gai` format specification is documented in `src/core/format/` and can be implemented independently.
