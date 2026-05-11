# Graphnosis Roadmap

This document describes what belongs in the core Graphnosis SDK and what doesn't. It is the reference for triaging issues and pull requests.

If a feature you want isn't listed here, please open an issue with the `proposal` label rather than going straight to a PR.

---

## Project shape

Graphnosis is intentionally a **small, focused, in-process SDK** for AI-native dual-graph knowledge representation. It does one thing: build, query, and persist typed knowledge graphs with deterministic semantics and offline-first defaults.

Anything beyond those primitives lives in separate packages or separate repositories. This separation keeps the SDK easy to embed, easy to audit, and easy to evolve.

---

## In scope — core SDK

These belong in `@nehloo/graphnosis`:

- **Graph engine.** Dual-graph (directed + undirected edges) data model, node/edge types, confidence + temporal fields.
- **Ingestion parsers.** Markdown, HTML, JSON, CSV, PDF, plain text. New parsers for common document formats are welcome via issue discussion.
- **Indexing.** TF-IDF index with pluggable analyzers, in-memory embedding index with pluggable adapters.
- **Querying.** `query()` (TF-IDF), `queryHybrid()` (TF-IDF + embeddings), `prompt()` builders, subgraph context serialization.
- **Corrections.** `edit`, `deleteNode`, `supersede`, `correct`, `importMarkdown`, `forgetByTopic`, `forgetByTimeWindow`. Soft-delete semantics.
- **Persistence.** `.aikg` binary format (MessagePack), SQLite store, HMAC signing for integrity, buffer-based I/O for serverless.
- **Reflection.** `reflect()` — contradictions, decayed nodes, surprising connections.
- **Adapter interfaces.** `EmbeddingAdapter`, `TextAnalyzer`. New built-in adapters for major providers (OpenAI, Voyage, Cohere) live in `@nehloo/graphnosis/adapters/*`.
- **Federation primitive.** `queryGraphs([...])` for in-process cross-graph queries.
- **MCP server.** Single-graph stdio MCP server for use with Claude Desktop and similar clients.
- **Documentation and examples** for all of the above.

Improvements to performance, correctness, ergonomics, and test coverage of anything in this list are always welcome.

---

## Out of scope

Anything outside the core graph-engine primitives listed above. If you're unsure whether your idea fits, open an issue with the `proposal` label and we'll discuss before you invest implementation time. The default for borderline cases is **"build it as a separate package that depends on Graphnosis."**

---

## Process for "I think this might be in scope but I'm not sure"

Open an issue with the `proposal` label. Describe:
1. What you want to build
2. What problem it solves
3. Why you think it belongs in the SDK rather than an adjacent package

We'll discuss before you invest implementation time. The default answer for borderline cases is **"build it as a separate package"** — but there are exceptions, and a short conversation is the cheapest way to get to the right answer.
