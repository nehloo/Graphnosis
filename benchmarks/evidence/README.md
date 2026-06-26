# Evidence — LongMemEval headline numbers

Sanitized per-question scoring records for every LongMemEval number reported in
the Graphnosis whitepaper (*The Un-Brain*, §12) and in [`../benchmarks.md`](../benchmarks.md).
Each `.jsonl` is one configuration's scoring output on the public **LongMemEval_S**
dataset ([xiaowu0162/LongMemEval](https://github.com/xiaowu0162/LongMemEval), 500
questions), produced at commit `a27c400` (`@nehloo/graphnosis` v0.7.1) — except the additive-scoring arm (v0.7.3 tag) and the two naïve-top-k arms, re-run under the post-v0.7.3 seed-sharing ablation hook (`seedsOnly`) that leaves the graph-arm retrieval path unchanged; the TF-IDF and naïve-top-k retrieval paths are unchanged through the published v0.7.2 (`48785ba`). The scorer in every
configuration is the official LongMemEval judge prompts run on **gpt-4o**.

**Sanitized.** The dataset's `question` and `gold` text are removed (LongMemEval
carries its own license). Each record keys to the public dataset by `question_id`
and retains our `predicted` answer, the `correct` verdict, `judgeRaw`, the
judge/answer model ids, and routing/diagnostic fields — enough to verify every
reported count against the public dataset.

| File | Score | Configuration |
|---|---|---|
| `cloud-paired-78.0.jsonl` | 390/500 (78.00%) | hybrid (cloud embeddings) + GPT-4o + gpt-4o-mini summaries/prefs |
| `zero-embed-enrich-64.6.jsonl` | 323/500 (64.60%) | TF-IDF + GPT-4o + gpt-4o-mini enrichment |
| `zero-embed-noenrich-62.2.jsonl` | 311/500 (62.20%) | TF-IDF graph + GPT-4o, no enrichment |
| `on-device-41.6.jsonl` | 208/500 (41.60%) | fully on-device — TF-IDF + Llama 3.2 3B (Ollama), zero cloud |
| `on-device-naive-topk-35.8.jsonl` | 179/500 (35.80%) | on-device flat baseline — naïve top-k + Llama 3.2 3B, router on, no graph (pairs with 41.6% → **+5.8** for the dual-graph) |
| `ablation-naive-topk-49.0.jsonl` | 245/500 (49.00%) | naïve top-k, GPT-4o, router on, no graph (pairs with 62.2% → **+13.2** for the dual-graph) |
| `ablation-full-context-22.6.jsonl` | 113/500 (22.60%) | full-context, GPT-4o, no retrieval |
| `ablation-additive-scoring-56.2.jsonl` | 281/500 (56.20%) | Thm 3 ablation — graph + **additive** scoring (vs 62.2% max-wins → **+6.0** for the rule) |

`manifest.json` carries the exact command for each. Verify any count, e.g.:

```sh
grep -c '"correct":true' cloud-paired-78.0.jsonl   # → 390
```

File integrity is pinned separately: `shasum -a 256 -c checksums.txt` verifies all eight
`.jsonl` against the SHA-256 digests, which are also recorded per run in `manifest.json`
alongside the exact reproducing command. Note the flag semantics documented there —
`run.ts` enables boolean flags by bare presence (`--enable-router`), and the
`--enable-router=true` form does **not** work.

The 78.00% headline reconciles per-category to **363/470** non-abstention +
**27/30** abstention = **390/500**; the abstention items (`_abs`) are distributed
across four categories, not a standalone class (see `../benchmarks.md`, Run 30).

Numbers were produced on the v0.6.1–v0.7.2 SDK line, whose TF-IDF retrieval path
is unchanged throughout; the headline figure was produced at commit `a27c400`
(v0.7.1), of which the published v0.7.2 (`48785ba`) is the direct descendant.
