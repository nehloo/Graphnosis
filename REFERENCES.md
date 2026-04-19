# Graphnosis — References & Attribution

---

## Directly Used

### Benchmark

Wu, X., Wang, J., Zhong, D., Gao, Z., Wang, Z., Chang, K.-W., & Wang, W. Y. (2025).
**LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory.**
*ICLR 2025.*
https://arxiv.org/abs/2410.10813

The 500-question evaluation dataset (`longmemeval_s`) that all benchmark runs in this repository are measured against. The GPT-4 judge prompts from this paper are used verbatim in `tests/longmemeval/official/judge.ts`.

---

### Infrastructure & Protocols

Anthropic / Linux Foundation (2024).
**Model Context Protocol Specification.**
https://modelcontextprotocol.io

The open protocol implemented by the Graphnosis MCP server (`src/mcp/`). Both the stdio transport (Mode 1, local / Claude Desktop) and the StreamableHTTP transport (Mode 2, enterprise Docker) conform to this specification.

---

MessagePack project.
**MessagePack Specification.**
https://msgpack.org

The binary serialization format underlying the `.gai` (Graphnosis AI) file format. Implemented via the `msgpackr` npm package in `src/core/format/gai-writer.ts` and `gai-reader.ts`.

---

### Models

OpenAI (2024). **GPT-4o** — answer model and GPT-4 judge for all benchmark runs.
OpenAI (2024). **GPT-4o-mini** — session summary generation (`src/core/enrichment/session-summarizer.ts`) and query-time preference extraction (`src/core/enrichment/preference-extractor.ts`).
OpenAI (2024). **text-embedding-3-small** — semantic retrieval embeddings in hybrid mode (`src/core/similarity/embeddings.ts`).

---

### Datasets

| Dataset | Source | License |
|---------|--------|---------|
| LongMemEval_s (500 QA pairs) | [huggingface.co/datasets/xiaowu0162/longmemeval](https://huggingface.co/datasets/xiaowu0162/longmemeval) | Apache 2.0 |
| Wikipedia — History of Computing (51 articles) | [wikipedia.org](https://wikipedia.org) | CC BY-SA 3.0 |
| arXiv — Transformer Architecture (25 papers) | [arxiv.org](https://arxiv.org) | Open Access |
| Next.js Documentation (30 pages) | [github.com/vercel/next.js](https://github.com/vercel/next.js) | MIT |
| NASA Mars Mission data | [api.nasa.gov](https://api.nasa.gov) | Public Domain |

### Origins

**'90s Neural Network C++ class** (personal project, late 1990s)
A handwritten C++ training loop that ingested pixel-drawn letter sketches, ran repeated training cycles, and identified the drawn character. The first personal experiment in machine pattern recognition — and the direct intellectual precursor to Graphnosis's approach of structured, typed knowledge representation for AI comprehension.

---

**EditIcon** — pixel editor companion tool (personal project, late 1990s)
https://github.com/nehloo/EditIcon
The pixel drawing tool used to create hand-drawn letter inputs for the neural network class above. Preserved as an artifact of that era. Referenced in the README ("The Question That Started This") as part of Graphnosis's origin story.

---

## Related Work

The following papers and systems address similar problems and are discussed in the README for context and comparison. Graphnosis was developed independently and does not derive from any of these works.

---

Edge, D., Trinh, H., Cheng, N., Bradley, J., Chao, A., Mody, A., Truitt, S., Metropolitansky, D., Ness, R. O., & Larson, J. (2024).
**From Local to Global: A Graph RAG Approach to Query-Focused Summarization.**
*Microsoft Research.*
https://arxiv.org/abs/2404.16130

---

Guo, Z., Xia, L., Yu, Y., Ao, T., & Huang, C. (2025).
**LightRAG: Simple and Fast Retrieval-Augmented Generation.**
*Findings of EMNLP 2025.*
https://arxiv.org/abs/2410.05779

---

Microsoft Research (2024).
**LazyGraphRAG: Setting a new standard for quality and cost** [blog post].
https://www.microsoft.com/en-us/research/blog/lazygraphrag-setting-a-new-standard-for-quality-and-cost/

---

Lewis, P., Perez, E., Piktus, A., Petroni, F., Karpukhin, V., Goyal, N., Küttler, H., Lewis, M., Yih, W., Rocktäschel, T., Riedel, S., & Kiela, D. (2020).
**Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks.**
*NeurIPS 2020.*
https://arxiv.org/abs/2005.11401
