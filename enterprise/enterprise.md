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

---

## Adopting Graphnosis as an NPM Dependency — Security & IT Guidance

This section is for engineering and security teams evaluating Graphnosis as an
embedded dependency inside a larger enterprise application (not the Docker/MCP
deployment described above). The SDK is published as `@nehloo/graphnosis` and
wraps the same graph engine used by the Next.js app — but restricted to a pure,
in-process surface that enterprise reviewers can audit in a single file.

### The "no-egress" guarantee — and how to verify it

**Guarantee:** importing `@nehloo/graphnosis` and using any of its public APIs
never initiates a network connection. No `fetch`, no HTTP client, no OpenAI
SDK call.

**How to verify it yourself** (takes ~5 minutes in a review):

1. Read `src/sdk/index.ts`. Every re-exported module is listed at the bottom
   of the file. The invariants banner at the top explicitly excludes
   `src/core/enrichment/*` and `src/core/query/answer.ts`, the only two
   modules in the repo that call OpenAI.
2. Grep the transitive import graph from `src/sdk/index.ts` for
   `@ai-sdk/openai`, `openai`, `fetch(`, `node:http`, `https.request`. You
   should find zero hits.
3. Run the SDK behind a network sandbox that blocks all egress
   (`unshare -n`, a restrictive seccomp profile, or a deny-all egress
   network policy in your pod). All SDK operations continue to work.

**What this means for the LLM step:** you, the consumer, make the LLM call
yourself with whatever client you prefer (Claude SDK, Azure OpenAI,
Bedrock, Ollama, vLLM). Graphnosis hands you a `prompt` string; you pick the
model. This is how you keep data residency under your control.

### `.gai` file integrity — use HMAC when files cross a trust boundary

The `.gai` format has two integrity modes:

| Mode | Trailer | Protects against | Use for |
|------|---------|------------------|---------|
| Checksum (default) | 4-byte additive sum | Bit rot, disk corruption | Files that never leave a single trusted machine |
| **HMAC-SHA256** (opt-in) | Checksum + 32-byte HMAC | Tampering, downgrade, forgery | **Everything else** |

The additive checksum is **not a security control** — an attacker who can
write to the file can trivially recompute it. Any `.gai` file that is:

- written by one tenant and read by another,
- uploaded to shared storage (S3, blob store, NFS),
- transferred over an untrusted network,
- received from an external party,

**must** be written with `writeGai(graph, { hmacKey })` and read with
`readGai(buffer, { hmacKey })`. The reader fails closed on any mismatch,
and also rejects the downgrade case where an attacker strips the HMAC
trailer (a key supplied against an unsigned file throws).

**Key management:**

- Minimum 32 bytes of CSPRNG-generated keying material per deployment.
- Rotate on a schedule that matches your other HMAC keys (typically 90
  days). Re-sign existing `.gai` files during rotation.
- Store in your existing secrets manager (AWS Secrets Manager, GCP Secret
  Manager, HashiCorp Vault, Azure Key Vault). Do not commit to source or
  bake into images.
- For multi-tenant deployments, derive a per-tenant key via HKDF from a
  single root so tenant A cannot verify or forge tenant B's files.

### Native module policy — SQLite is optional

`better-sqlite3` is declared as an **optional dependency**. The SDK loads it
lazily — if it isn't installed, the SDK works for everything except
`saveSqlite/loadSqlite`, which throw a clear install-hint error. Enterprise
installs can skip it:

```bash
npm install @nehloo/graphnosis --omit=optional
```

This avoids pulling in native (C++) code and the `node-gyp` / prebuilt-binary
toolchain. If you do install it, verify its prebuilt binary via npm's
package provenance or pin to a specific version + integrity hash in your
lockfile.

Without SQLite the SDK still supports:

- In-memory graphs (default).
- `.gai` binary persistence (file read/write only — no native deps).
- All query, build, and prompt operations.

### Parser CVE surface — treat user-submitted files as untrusted

The SDK exposes parsers for many file formats. These parse arbitrary bytes,
and parser bugs are a classic CVE vector (malformed-input crashes, ReDoS,
prototype pollution). Enterprise review should treat the following as
"untrusted input sinks":

| Parser | Format | Typical risks |
|--------|--------|---------------|
| `pdf-parse` | PDF | Malformed streams, memory exhaustion |
| `exif-parser` | JPEG/TIFF EXIF | Malformed tags, integer overflow |
| `music-metadata` | Audio containers | Malformed ID3/metadata |
| `cheerio` | HTML | Known ReDoS classes in HTML parsing |
| `papaparse` | CSV | Memory exhaustion on pathological input |
| `remark-parse` | Markdown | Pathological AST shapes |
| `wtf_wikipedia` | MediaWiki | Template expansion complexity |

**Guidance:**

1. **Sandbox ingest.** If you ingest files from end users, run the parse
   step in a short-lived worker (Node `worker_threads`, a container, or a
   subprocess) with CPU + memory limits. Graphnosis is in-process, but the
   ingest step can be split into its own sandbox without changing the SDK.

   **Minimal `worker_threads` example:**

   ```ts
   // ingest-worker.ts — runs in a worker thread, crash-isolated from host
   import { workerData, parentPort } from 'node:worker_threads';
   import { Graphnosis } from '@nehloo/graphnosis';

   const { content, filename, graphName } = workerData as {
     content: string;
     filename: string;
     graphName: string;
   };

   const g = new Graphnosis({ name: graphName });
   g.addMarkdown(content, filename);
   g.build();
   const serialized = g.toSerializable();
   parentPort!.postMessage({ ok: true, serialized });
   ```

   ```ts
   // host.ts — spawns a bounded worker per user upload
   import { Worker } from 'node:worker_threads';
   import { fileURLToPath } from 'node:url';
   import { readFileSync } from 'node:fs';

   const WORKER_TIMEOUT_MS = 30_000; // kill runaway parses after 30 s

   export function ingestFileIsolated(
     filePath: string,
     graphName: string
   ): Promise<unknown> {
     return new Promise((resolve, reject) => {
       const worker = new Worker(
         fileURLToPath(new URL('./ingest-worker.js', import.meta.url)),
         {
           workerData: {
             content: readFileSync(filePath, 'utf8'),
             filename: filePath,
             graphName,
           },
           // Limit memory — worker is killed if it exceeds this
           resourceLimits: { maxOldGenerationSizeMb: 256 },
         }
       );

       const timer = setTimeout(() => {
         worker.terminate();
         reject(new Error(`Ingest worker timed out after ${WORKER_TIMEOUT_MS}ms`));
       }, WORKER_TIMEOUT_MS);

       worker.on('message', (msg) => { clearTimeout(timer); resolve(msg); });
       worker.on('error', (err) => { clearTimeout(timer); reject(err); });
       worker.on('exit', (code) => {
         clearTimeout(timer);
         if (code !== 0) reject(new Error(`Ingest worker exited with code ${code}`));
       });
     });
   }
   ```

   > **Why this works:** a crash in a parser (stack overflow, OOM, uncaught exception)
   > kills the worker thread, not the host process. The `resourceLimits.maxOldGenerationSizeMb`
   > cap prevents a pathological input from exhausting host heap. The timeout
   > kills runaway parses (ReDoS, infinite loops) after a bounded wall-clock window.

2. **Enable Dependabot / Snyk** on your consuming project so CVEs in the
   parser dependencies surface as pull requests.
3. **Pin versions + commit the lockfile.** Use `npm ci` in CI so the
   resolved transitive tree is the one you audited.
4. **Mirror via internal registry.** For air-gapped or regulated
   environments, mirror `@nehloo/graphnosis` and its deps through
   Artifactory / Nexus / CodeArtifact. Enable `npm audit signatures` to
   verify provenance against the public registry.

### Indirect prompt injection — a shared-responsibility risk

`graphnosis.prompt(question)` inlines node `content` verbatim into the LLM
system prompt. If any of that content originated from a user-submitted
source, the resulting prompt is a textbook indirect prompt-injection vector
— a user can plant instructions in a document that later hijack the model.

This is inherent to all RAG systems and not specific to Graphnosis. Your
mitigations:

- **Sanitize at ingest.** Strip known injection markers (e.g. `<|im_start|>`,
  role tags, `[INST]` sequences) when adding user-submitted content.
- **Constrain the downstream LLM.** Prefer models + configs that do not
  expose tool-use or arbitrary code execution to whatever is in the system
  prompt. If tool-use is required, filter tool calls against an allowlist
  and never let tool output bypass your auth layer.
- **Output filtering.** Log and review LLM responses for signals of hijack
  (unexpected formatting, attempts to exfiltrate, role-break attempts).
- **Provenance in the prompt.** Graphnosis already tags every node with its
  source file (`src:...`). Use that in your downstream system prompt to
  instruct the model to trust system turns over any `src:User (...)`
  content.

### Path handling — do not pass user input

`saveGai`, `loadGai`, `saveSqlite`, `loadSqlite`, and `openSqliteStore` all
forward their path argument directly to `node:fs` / `better-sqlite3`. A
user-controlled string here is a path-traversal vulnerability.

- Only pass paths your code constructs.
- Canonicalize via `path.resolve` and confirm the result stays inside an
  expected base directory before passing.
- Never concatenate user input into a DB or `.gai` filename.

### Supply chain — what we do, what you do

**What we do (publisher side):**

- Scoped package (`@nehloo/graphnosis`) so only members of the `nehloo` npm
  org can publish.
- `publishConfig.access: "restricted"` by default. Consumers need explicit
  access; the package is not on the public registry until we flip it.
- `publishConfig.provenance: true` enables npm's signed build attestations
  via GitHub Actions.
- Publish with 2FA + OTP.
- `prepublishOnly` runs lint + build so a broken tarball cannot ship.

**What you should do (consumer side):**

- Commit `package-lock.json`; build with `npm ci` in CI, not `npm install`.
- Enable `npm audit signatures` in CI (`npm audit signatures --omit=dev`).
- Mirror through an internal registry for air-gapped or regulated envs.
- Pin the version. Do not use `^` or `~` for security-sensitive graphs.
- Monitor the `@nehloo/graphnosis` package for new releases and review
  changelogs before bumping.
- Attach an SBOM to your release pipeline. `npm sbom --sbom-format cyclonedx`
  emits one that includes the Graphnosis subtree.

### Data in transit — there is no TLS surface

The SDK is strictly in-process. It does not bind a port, does not serve a
network endpoint, does not accept remote connections. If you wrap Graphnosis
in an HTTP / gRPC service, terminate TLS at your gateway or service mesh —
Graphnosis has no networking layer of its own to configure.

This is deliberate: the attack surface is whatever your wrapper code
exposes, not the library. Enterprise review reduces to reviewing your
wrapper.

### Incremental ingestion — appending to a live graph

The SDK supports appending new documents to an already-built graph without a
full rebuild. This is the recommended pattern for long-running services that
receive user-submitted files or continuous data feeds.

```ts
import { Graphnosis } from '@nehloo/graphnosis';

// On startup — load persisted graph
const g = new Graphnosis({ name: 'enterprise-kb' });
g.loadGai('/data/kb.gai', { hmacKey: process.env.GAI_HMAC_KEY! });

// On each user upload
app.post('/ingest', (req, res) => {
  // Run parse in a worker thread for crash isolation (see sandboxing section)
  const { newNodes, newDirectedEdges } = g.appendMarkdown(req.body.content, req.body.filename);
  g.saveGai('/data/kb.gai', { hmacKey: process.env.GAI_HMAC_KEY! });
  res.json({ newNodes, newDirectedEdges });
});
```

**Security notes:**
- Content-hash deduplication prevents the same document from inflating the
  graph if ingested twice.
- `appendMarkdown` / `appendText` / `appendHtml` etc. are synchronous and
  in-process — run them in a worker thread when the source is untrusted
  (see the sandboxing example above).
- File path arguments are not involved in append operations; only the parsed
  content string is processed.

### Multi-graph federation — querying across isolated knowledge bases

For deployments that maintain separate graphs per tenant, domain, or data
classification level, `queryGraphs()` merges results at query time without
sharing any graph state between instances.

```ts
import { Graphnosis, queryGraphs } from '@nehloo/graphnosis';

// Each tenant graph loaded from its own isolated store
const tenantGraph = new Graphnosis({ name: `tenant-${tenantId}` });
tenantGraph.loadSqlite('/data/tenants.db', tenantId);

const globalGraph = new Graphnosis({ name: 'global-policy' });
globalGraph.loadGai('/data/policy.gai', { hmacKey: process.env.GAI_HMAC_KEY! });

// Query both — results merged and deduplicated by content hash
const prompt = queryGraphs([tenantGraph, globalGraph], userQuestion);
// pass prompt to your LLM
```

**Security architecture:**
- Each graph instance is fully in-process — no IPC, no shared memory, no
  network calls between graphs.
- Cross-graph deduplication is by content hash only — no node IDs or
  metadata leak across graph boundaries.
- Access controls remain your responsibility: ensure only the correct
  tenant graphs are loaded for each request. `queryGraphs` does not
  enforce any RBAC; it merges whatever instances you pass to it.
- For strict data-classification requirements, load graphs in separate
  worker threads so a crash in one tenant's graph cannot affect another's
  query in progress.

### Summary — enterprise adoption checklist

- [ ] Reviewed `src/sdk/index.ts` and confirmed the no-egress invariant.
- [ ] Using HMAC mode (`hmacKey` option) for every `.gai` file that leaves
      the single-machine trust boundary. Key stored in a secrets manager.
- [ ] Decided on SQLite vs. `.gai`-only; installed `better-sqlite3`
      explicitly if needed, with pinned version + integrity hash.
- [ ] Ingest of user-submitted files runs under a resource-limited sandbox
      (worker_threads with resourceLimits + timeout — see sandboxing example).
- [ ] Incremental append (`g.appendMarkdown` etc.) used for live ingestion
      rather than full rebuild, to bound per-request latency.
- [ ] Multi-graph federation access controls validated: only the correct
      tenant/classification graphs are passed to `queryGraphs()` per request.
- [ ] Dependabot / Snyk enabled on the consuming project.
- [ ] Lockfile committed; CI uses `npm ci`; `npm audit signatures` runs in CI.
- [ ] Internal registry mirror configured for air-gapped envs.
- [ ] Downstream LLM call path has prompt-injection mitigations (allowlisted
      tools, output filtering, role-provenance in system prompt).
- [ ] No path arguments to persistence APIs are user-controlled.
- [ ] Wrapper service (if any) terminates TLS at a gateway, with its own
      authn/authz layer in front of Graphnosis APIs.
