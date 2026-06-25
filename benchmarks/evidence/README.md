# Evidence — LongMemEval headline numbers

Sanitized per-question scoring records for every LongMemEval number reported in
the Graphnosis whitepaper (*The Un-Brain*, §12) and in [`../benchmarks.md`](../benchmarks.md).
Each `.jsonl` is one configuration's scoring output on the public **LongMemEval_S**
dataset ([xiaowu0162/LongMemEval](https://github.com/xiaowu0162/LongMemEval), 500
questions), produced with `@nehloo/graphnosis` v0.7.2. The scorer in every
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
| `ablation-naive-topk-44.8.jsonl` | 224/500 (44.80%) | naïve top-k, GPT-4o, no graph |
| `ablation-full-context-22.6.jsonl` | 113/500 (22.60%) | full-context, GPT-4o, no retrieval |

`manifest.json` carries the exact command for each. Verify any count, e.g.:

```sh
grep -c '"correct":true' cloud-paired-78.0.jsonl   # → 390
```

The 78.00% headline reconciles per-category to **363/470** non-abstention +
**27/30** abstention = **390/500**; the abstention items (`_abs`) are distributed
across four categories, not a standalone class (see `../benchmarks.md`, Run 30).

Numbers were produced on the v0.6.1–v0.7.2 SDK line, whose TF-IDF retrieval path
is unchanged throughout; the headline configuration corresponds to the published
v0.7.2.
