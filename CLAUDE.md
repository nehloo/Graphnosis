# graphAI — Project Context

## What This Is
A research prototype exploring AI-native knowledge representation through dual-graph structures.
Core thesis: structured graphs with typed edges outperform flat text chunks for AI comprehension.

## Architecture
```
RAW FILES → PARSE → CHUNK → EXTRACT → BUILD GRAPH → OPTIMIZE → .gai
                                                         ↓
                                              ENRICHMENT (optional LLM)
                                                         ↓
                                              QUERY / GIKI / AUDIT / CORRECT
```

- **Dual graph:** directed edges (causal, temporal, hierarchical, identity) + undirected edges (similarity, co-occurrence) over same node set
- **Temporal:** nodes track createdAt, lastAccessedAt, accessCount, validUntil, confidence (decays after 7 days)
- **Similarity:** TF-IDF + cosine (pure JS, zero API calls) with inverted term index optimization
- **Query:** synonym expansion → query decomposition → merged seed finding → BFS with temporal scoring → enriched subgraph serialization
- **Persistence:** SQLite (better-sqlite3, WAL mode) or in-memory
- **Format:** .gai binary (MessagePack with magic bytes + checksum)

## Key Technical Decisions
- AI SDK v6: `useChat` from `@ai-sdk/react`, `DefaultChatTransport` for custom API URL, `sendMessage({text})`, `status` not `isLoading`, `msg.parts` not `msg.content`
- Server route manually converts UIMessages (parts-based) to ModelMessages (content-based) for `streamText`
- `react-force-graph-2d` callbacks need `any` types due to library's generic node/link typing
- Undirected edge builder uses inverted term index to avoid O(n^2) full scan
- Contradiction detection uses strict conflict patterns (not loose negation words)
- Chat context fetch tracks `lastContextMsgId` to prevent re-fetch on streaming tokens

## Commands
```bash
npm run dev    # Start dev server (port 3000)
npm run build  # Production build
npm run lint   # ESLint
```

## Environment
```
OPENAI_API_KEY=sk-...  # Required for chat + enrichment
NASA_API_KEY=...       # Optional, defaults to DEMO_KEY
```

## Pages (8)
Dashboard, Examples, Graph, Chat, Correct, Giki, Audit, Benchmarks

## API Routes (10)
```
POST /api/examples/[dataset]     # Load a PoC dataset
GET  /api/graph                  # Graph data for visualization
POST /api/graph/query            # Chat query (streaming LLM)
POST /api/graph/context          # Subgraph context (no LLM)
GET  /api/graph/benchmark        # Run 10 query benchmarks
GET  /api/graph/audit            # Entity reports, contradictions, health
POST /api/graph/correct          # Apply corrections, bulk import, forget by time/topic, cascade delete
GET  /api/graph/giki             # Generate topic pages with citations
POST /api/graph/enrich           # LLM enrichment pass
POST /api/graph/reflect          # Run reflection engine (contradictions, decay, inference, discovery)
GET  /api/graph/longmemeval      # Run LongMemEval test suite
```

## File Layout
```
src/core/
  types.ts                      # 40+ interfaces (nodes, edges, identity, conversation, reflection)
  constants.ts                  # Thresholds, stopwords, magic bytes
  ingestion/parsers/            # markdown, pdf, html, csv/json, conversation (Claude/ChatGPT/Slack/raw)
  extraction/                   # chunker, entity-extractor, identity-extractor
  similarity/                   # tfidf, cosine, jaccard
  graph/                        # graph-builder, directed-edges, undirected-edges, incremental, graph-store
  optimization/                 # deduplicator, pruner, compressor, reflection (contradictions + discovery)
  format/                       # gai-writer, gai-reader
  query/                        # query-engine, seed-finder, traverser, subgraph-serializer,
                                  synonym-expander, query-decomposer
  enrichment/                   # node-enricher (LLM synthesis + context)
  corrections/                  # correction-engine (add/edit/supersede/delete/bulk)
  giki/                         # giki-generator (topic pages with node citations)
  audit/                        # audit-exporter (entity reports, health, markdown export)
  persistence/                  # sqlite-store (better-sqlite3, WAL)
src/examples/                   # 4 PoC fetchers (wikipedia, arxiv, nextjs-docs, nasa-mars)
src/app/                        # Next.js pages + API routes
tests/longmemeval/              # 12 tests across 4 categories
data/                           # Runtime: .gai files, SQLite db, cache (gitignored)
```

## Guardrails
- Content hash deduplication prevents duplicate nodes
- Auto-pruning removes orphan nodes after graph construction
- Edge weight thresholds: similarity >= 0.3, entity Jaccard >= 0.2
- Max 10 edges per node, max 50 similarity candidates per node
- Max 20 nodes per query subgraph (~2K tokens avg)
- BFS capped at 3 hops with 0.6 decay factor
- Temporal: confidence decays ~1%/day after 7 days without access (floor 0.1)
- Contradiction detection: strict conflict patterns only (reclassified, disputed, disproven, etc.)
- Corrections: soft-delete (validUntil + confidence 0.1), never hard-delete
- Bulk forget: by time window (before date) or by topic (entity/content match)
- Cascade soft-delete: follows contains edges + same-source to soft-delete downstream nodes
- Reflection engine: callable on-demand via POST /api/graph/reflect
- .gai checksum validates file integrity on read
- All dependencies MIT or Apache-2.0 licensed
