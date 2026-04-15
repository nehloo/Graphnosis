# LongMemEval (Official) — Graphnosis Runner

Runs the real ICLR 2025 benchmark from [xiaowu0162/LongMemEval](https://github.com/xiaowu0162/LongMemEval) end-to-end against Graphnosis:

1. Build an isolated knowledge graph from each question's ~50-session haystack
2. Query the graph and generate an answer (`gpt-4o-mini` by default — the same model as `/api/graph/query`)
3. Score the answer with the official LongMemEval GPT-4 judge prompts (verbatim copy of `src/evaluation/evaluate_qa.py::get_anscheck_prompt`)

Output: per-question-type and overall accuracy directly comparable to published leaderboard numbers (Agentmemory V4, PwC Chronos, OMEGA, Mastra, Supermemory, Zep).

Unlike `tests/longmemeval/longmemeval.test.ts` (12 custom questions with keyword matching), this runner produces legitimate LongMemEval scores.

## One-time setup

1. Download `longmemeval_s.json` from the Hugging Face dataset page:
   <https://huggingface.co/datasets/xiaowu0162/longmemeval>
2. Place it at `data/longmemeval/longmemeval_s.json` (gitignored; ~30 MB).
3. Install deps (adds `tsx` for running TypeScript directly):
   ```bash
   npm install
   ```
4. Export your OpenAI key:
   ```bash
   export OPENAI_API_KEY=sk-...
   ```

## Retrieval modes

Pick one with `--retrieval` (or use the convenience npm scripts below):

| Mode | Behavior | API cost beyond answer+judge |
| --- | --- | --- |
| `tfidf` (default) | Lexical TF-IDF only — no embedding API calls | $0 |
| `embeddings` | Semantic only — embeds the haystack and the query, ranks by cosine | ~$0.001 per question (text-embedding-3-small) |
| `hybrid` | Both pools merged: TF-IDF seeds + embedding seeds, then diversified | ~$0.001 per question |

Embedding model is configurable via `--embedding-model` (default `text-embedding-3-small`; `text-embedding-3-large` is ~6x more expensive but slightly stronger).

## Running

Smoke (20 questions, ~5 min):
```bash
npm run longmemeval:smoke              # tfidf, the default
npm run longmemeval:smoke:embeddings   # embeddings only
npm run longmemeval:smoke:hybrid       # tfidf + embeddings merged
```

Full 500 (~1–2 hours; embedding modes add ~$0.50 in API cost):
```bash
npm run longmemeval:real
npm run longmemeval:real:embeddings
npm run longmemeval:real:hybrid
```

Custom flags:
```bash
npx tsx tests/longmemeval/official/run.ts \
  --dataset data/longmemeval/longmemeval_s.json \
  --out data/longmemeval/results \
  --retrieval hybrid \
  --embedding-model text-embedding-3-small \
  --limit 50 \
  --types temporal-reasoning,multi-session \
  --judge gpt-4o \
  --answer-model gpt-4o-mini \
  --concurrency 4 \
  --seed 42
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--dataset` | `data/longmemeval/longmemeval_s.json` | Path to LongMemEval JSON |
| `--out` | `data/longmemeval/results` | Output directory |
| `--limit N` | (all) | Sample first N after seeded shuffle |
| `--types a,b` | (all) | Restrict to question types |
| `--judge` | `gpt-4o` | Judge model (`gpt-4o` or `gpt-4o-mini`) |
| `--answer-model` | `gpt-4o-mini` | Answering model |
| `--retrieval` | `tfidf` | `tfidf` \| `embeddings` \| `hybrid` |
| `--embedding-model` | `text-embedding-3-small` | OpenAI embedding model |
| `--concurrency` | `4` (tfidf) / `2` (embeddings, hybrid) | Parallel questions in flight. Embedding modes default lower to stay under OpenAI's 1M TPM window. |
| `--seed` | `42` | Sampling seed (deterministic with `--limit`) |
| `--max-nodes` | `30` | Subgraph node cap passed to the retriever (app default is 20) |
| `--dump-prompts` | `false` | Also write `prompts.jsonl` with the full system prompt per question (debugging) |

## Output

Files written to the `--out` directory:

- `results.jsonl` — one result per line; used for **resume** (re-running skips already-scored `question_id`s)
- `results.json` — full run with summary + args
- `results.md` — human-readable report with per-type accuracy and leaderboard context

## Verification steps

1. Run smoke, inspect `results.md` — do judgments look sane?
2. Pick 3 failed questions and re-read the haystack manually to confirm it's a real miss, not a pipeline bug.
3. Run per-type (`--types single-session-user` then `--types temporal-reasoning`) before committing to the full 500.
4. Independence check: run smoke twice with the same seed — deltas should be < ~2% (judge is called with `temperature: 0`).

## Why the leaderboard comparison is honest

The `100%` claims from MemPalace / ZeroMemory used `recall_any@5` (did the right memory appear in the top 5 retrievals?) — they never ran the generate + judge pipeline. This runner uses the exact prompts from the paper's reference implementation and reports end-to-end QA accuracy, the same metric Agentmemory V4 (96.20%), Chronos (95.60%), OMEGA (95.40%), and Mastra (94.87%) report.
