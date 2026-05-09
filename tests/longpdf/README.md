# Long-PDF benchmark

Evaluates HippoCortex on the input shape PageIndex is built for: long, structured documents.
Spec lives at `~/.claude/plans/how-does-hippocortex-compare-eventual-fox.md` (Part D).

**Corpus version:** v1 (NVDA FY2024 10-K + Postgres 16 whole-docs A4 PDF + OLMo 2 paper, arXiv:2501.00656, CC-BY 4.0).
**Question count:** 30 (10 per doc; 4 lookup + 4 cross-section + 2 inferential).
**Retrieval @ k:** k = 20.
**Baselines:** B1 HippoCortex as-is · B2 vanilla embedding RAG (200 lines).

## Layout

```
tests/longpdf/
  corpus/                  # gitignored — fetch per corpus/README.md
  questions.skeleton.jsonl # questions + gold_sections (committed); gold_answer is left blank
  questions.local.jsonl    # gitignored — your filled-in copy with gold_answers
  # Note: corpus is now all-PDF (filing.pdf, manual.pdf, paper.pdf). The
  # parseMarkdown ingestion path is not exercised by this benchmark.
  judge-prompt.md          # locked LLM-as-judge rubric
  types.ts
  dataset.ts               # load + validate questions.jsonl
  judge.ts                 # LLM-as-judge wrapper
  score.ts                 # retrieval@k + verdict aggregation
  baselines/
    hippocortex.ts          # B1 — calls answerQuestion() in-process
    embedding-rag.ts       # B2 — vanilla cosine top-k over OpenAI embeddings
  harness.ts               # entrypoint
  results/<YYYY-MM-DD>/    # gitignored — per-run output
```

## Workflow

1. Fetch the three documents per `corpus/README.md` and write `corpus/CHECKSUMS.txt`.
2. Copy the skeleton: `cp questions.skeleton.jsonl questions.local.jsonl`.
3. Open each document and fill in `gold_answer` for every row in `questions.local.jsonl`.
   Verify `gold_sections` while you're there — adjust if a heading is wrong.
4. Dry run (no API calls): `npm run longpdf -- --dry-run --questions questions.local.jsonl`.
   This validates the questions, ingests both baselines, and prints retrieval@k
   only. Useful for iterating on questions without burning judge tokens.
5. Real run: `npm run longpdf -- --questions questions.local.jsonl`.
6. Hand-grade 6 judge verdicts. If disagreement > 1, revise `judge-prompt.md`,
   re-run only the judge step, do not touch the baselines.
7. Write `results/<date>/summary.md` with the breakout table and 3–5 paragraphs
   of honest interpretation.

## Honesty pre-commitments

- Questions, gold sections, gold answers, and judge prompt are committed
  before the first real run.
- No edits to HippoCortex between question lock and result publish.
- Per-tier and per-document numbers are reported, not just an aggregate.
- If HippoCortex loses a tier, that tier ships in the report.
