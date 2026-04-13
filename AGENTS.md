# Bignosis — Agent Guidelines

## Project Overview

Bignosis is a research prototype that converts raw files into AI-optimized dual-graph knowledge representations. It explores whether structured graphs with typed edges can outperform flat-text RAG for AI comprehension and retrieval.

**Name:** Bignosis = **bi-** (two edge types over the same node set) + **gnosis** (knowledge). Formerly "graphAI"; renamed to avoid collision with `receptron/graphai` and the GraphAI Inc. trademark.

**Origin:** The project began with the question "Are AI models based on non-oriented graphs?" — which evolved into exploring whether knowledge represented as directed + undirected graphs, serialized in a binary format not designed for human readability, could produce better AI outputs than human-readable formats like markdown.

**Prior art:** Microsoft GraphRAG, LightRAG, LazyGraphRAG explore graph-based RAG. Bignosis's contribution is the specific combination of dual-graph (directed+undirected over same nodes) + AI-native binary format + human audit trail + temporal awareness + identity extraction + reflection engine — which hasn't been published as a unified system.

## Architecture Principles

1. **Dual-graph over same node set.** Every knowledge unit (node) has both directed edges (causal, temporal, hierarchical, identity) and undirected edges (similarity, association). This provides richer reasoning paths than either graph type alone.

2. **AI-native serialization.** The .gai binary format (MessagePack) is optimized for token efficiency, not human readability. The subgraph serialization format (`[nodeId|type|score] content`) is designed for LLM consumption.

3. **Zero-API similarity.** TF-IDF + cosine similarity runs entirely in-process with no external API calls. This makes the pipeline fully local and open-source friendly. Embedding support is optional.

4. **Explicit relationships in prompts.** Instead of flat text chunks, the LLM receives a structured subgraph with typed edges. This enables chain-of-thought reasoning along graph edges rather than forcing the model to infer connections.

5. **Temporal awareness.** Nodes track creation time, access patterns, and confidence scores. Knowledge decays if not reinforced. Superseded information remains in the graph but scores lower. Corrections get maximum confidence.

6. **Identity as first-class.** People mentioned across sources get dedicated person nodes with relationship edges. The system tracks who knows whom, who worked on what, and infers user preferences from conversation patterns.

7. **Human-in-the-loop.** Corrections (add/edit/supersede/soft-delete) feed back into the graph with maximum confidence. Giki pages provide human-readable views with node citations. Audit reports surface contradictions and coverage gaps.

## Security and Robustness Guardrails

### Input Validation
- All file parsers handle malformed input gracefully (empty content, missing sections)
- PDF parser uses heuristic section detection with fallback to single-section mode
- CSV/JSON parsers validate structure before processing
- Conversation parser auto-detects format (Claude/ChatGPT/Slack/raw) with fallback
- Wikipedia/arXiv/NASA fetchers have per-request error handling

### Graph Integrity
- **Content hash deduplication:** Identical content produces identical hashes; duplicates are merged
- **Auto-pruning:** Orphan nodes (zero edges) are removed after graph construction
- **Checksum verification:** .gai files include a 4-byte checksum; corrupted files are rejected
- **Edge weight thresholds:** Similarity >= 0.3, entity Jaccard >= 0.2. Below these, edges aren't created
- **Soft-delete only:** Corrections never hard-delete. Soft-delete sets validUntil + confidence 0.1

### Performance Bounds
- **O(n) similarity via inverted index:** Terms appearing in 500+ documents are skipped
- **Max 10 edges per node:** Prevents hub explosion
- **Max 50 similarity candidates per node:** Caps comparison work
- **Max 20 nodes per query subgraph:** Keeps token budget bounded (~2K tokens avg)
- **3-hop BFS with 0.6 decay:** Score decays exponentially with distance
- **Contradiction detection:** Strict patterns only (reclassified, disputed, disproven) — not loose negation words
- **Rate limiting:** Wikipedia (100ms), arXiv (3s), NASA (2s) between API requests

### Temporal Safety & Forgetting
- Confidence decays ~1%/day after 7 days without access (floor at 0.1)
- Expired nodes (validUntil < now) score 0.3x in queries
- Superseded nodes retain original content for audit trail
- Human corrections always get confidence 1.0
- Bulk forget by time window: soft-deletes all nodes created before a given date
- Bulk forget by topic: soft-deletes all nodes matching an entity or content string
- Cascade soft-delete: follows contains edges and same-source to soft-delete downstream nodes
- Nothing is ever hard-deleted — all forgetting is reversible via the audit trail
- Reflection engine (POST /api/graph/reflect): runs contradiction detection, confidence decay, transitive edge inference, and cross-domain discovery on demand

### Data Safety
- SQLite persistence with WAL mode for concurrent reads
- API keys loaded from environment variables, never hardcoded
- .env files are gitignored; only .env.example is committed
- No user data transmitted beyond the current session
- All dependencies MIT or Apache-2.0 licensed

## Code Conventions

- TypeScript strict mode throughout
- All graph types defined in `src/core/types.ts` — single source of truth (40+ interfaces)
- Parsers are stateless functions: `(input, sourceFile) -> ParsedDocument`
- Graph operations are pure: `(graph, params) -> { graph, stats }`
- AI SDK v6 patterns: `@ai-sdk/react` for client, manual UIMessage->ModelMessage conversion on server
- Chat context fetch tracks `lastContextMsgId` to prevent re-fetch on streaming tokens

## Key Files

| File | Purpose |
|------|---------|
| `src/core/types.ts` | All TypeScript interfaces — the data model |
| `src/core/graph/graph-builder.ts` | Central module: documents -> dual graph (with auto-pruning) |
| `src/core/graph/undirected-edges.ts` | TF-IDF similarity + entity overlap edges |
| `src/core/query/query-engine.ts` | Enhanced query: decompose + expand + merge seeds + enrich |
| `src/core/format/gai-writer.ts` | .gai binary serialization |
| `src/core/query/subgraph-serializer.ts` | Structured format sent to LLM |
| `src/core/optimization/reflection.ts` | Contradiction detection, connection discovery, decay, inference |
| `src/core/corrections/correction-engine.ts` | Human corrections: add/edit/supersede/delete/bulk |
| `src/core/giki/giki-generator.ts` | Graph -> human-readable topic pages with citations |
| `src/core/audit/audit-exporter.ts` | Entity reports, health dashboard, markdown export |
| `src/core/enrichment/node-enricher.ts` | LLM synthesis + context per node |
| `src/core/extraction/identity-extractor.ts` | Person extraction + relationship edges |
| `src/core/persistence/sqlite-store.ts` | SQLite graph store (WAL mode, indexed) |
| `tests/longmemeval/longmemeval.test.ts` | 12 benchmark tests across 4 categories |

<!-- BEGIN:nextjs-agent-rules -->
# Next.js Version Notice
This project uses Next.js 16. APIs, conventions, and file structure may differ from training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->
