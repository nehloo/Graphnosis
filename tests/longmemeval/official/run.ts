// CLI runner for the official LongMemEval benchmark against Graphnosis.
//
// Usage:
//   npm run longmemeval:smoke             # 20-question smoke (default seed)
//   npm run longmemeval:real              # all 500 questions
//   npx tsx tests/longmemeval/official/run.ts \
//     --dataset data/longmemeval/longmemeval_s.json \
//     --out data/longmemeval/results \
//     --limit 50 --types temporal-reasoning,multi-session \
//     --judge gpt-4o --answer-model gpt-4o-mini --concurrency 4
//
// Env: OPENAI_API_KEY is required.

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { loadDataset, isAbstention, type LMEQuestion, type LMEQuestionType } from './dataset';
import { buildGraphForQuestion, normalizeDate } from './ingest';
import { judgeAnswer, type JudgeModel } from './judge';
import { answerQuestion, type RetrievalMode } from '@/core/query/answer';
import { attachEmbeddings } from '@/core/graph/graph-builder';

interface CliArgs {
  dataset: string;
  out: string;
  limit?: number;
  types?: LMEQuestionType[];
  judge: JudgeModel;
  answerModel: string;
  concurrency: number;
  seed: number;
  maxNodes: number;
  dumpPrompts: boolean;
  retrieval: RetrievalMode;
  embeddingModel: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = 'true';
      }
    }
  }

  const limit = args.limit ? parseInt(args.limit, 10) : undefined;
  const types = args.types
    ? (args.types.split(',').map(s => s.trim()) as LMEQuestionType[])
    : undefined;

  return {
    dataset: args.dataset ?? 'data/longmemeval/longmemeval_s.json',
    out: args.out ?? 'data/longmemeval/results',
    limit,
    types,
    judge: (args.judge as JudgeModel) ?? 'gpt-4o',
    answerModel: args['answer-model'] ?? 'gpt-4o-mini',
    // Embedding modes burst against the OpenAI TPM window (~1M/min on
    // text-embedding-3-small). Default to lower concurrency unless the
    // caller overrides explicitly.
    concurrency: args.concurrency
      ? parseInt(args.concurrency, 10)
      : (args.retrieval && args.retrieval !== 'tfidf' ? 2 : 4),
    seed: args.seed ? parseInt(args.seed, 10) : 42,
    maxNodes: args['max-nodes'] ? parseInt(args['max-nodes'], 10) : 30,
    dumpPrompts: args['dump-prompts'] === 'true',
    retrieval: ((args.retrieval ?? 'tfidf') as RetrievalMode),
    embeddingModel: args['embedding-model'] ?? 'text-embedding-3-small',
  };
}

interface QuestionResult {
  question_id: string;
  question_type: LMEQuestionType;
  abstention: boolean;
  question: string;
  gold: string;
  predicted: string;
  correct: boolean;
  judgeRaw: string;
  judgeModel: string;
  answerModel: string;
  nodeCount: number;
  ingestMs: number;
  answerMs: number;
  judgeMs: number;
  error?: string;
}

function loadDone(jsonlPath: string): Set<string> {
  const done = new Set<string>();
  if (!existsSync(jsonlPath)) return done;
  const raw = readFileSync(jsonlPath, 'utf-8');
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as QuestionResult;
      if (r.question_id) done.add(r.question_id);
    } catch {
      // Skip malformed lines - run will overwrite via append
    }
  }
  return done;
}

async function runOne(
  q: LMEQuestion,
  answerModel: string,
  judge: JudgeModel,
  maxNodes: number,
  retrieval: RetrievalMode,
  embeddingModel: string
): Promise<{ result: QuestionResult; systemPrompt?: string }> {
  const base = {
    question_id: q.question_id,
    question_type: q.question_type,
    abstention: isAbstention(q),
    question: q.question,
    gold: q.answer,
  };

  try {
    const t0 = performance.now();
    let graph = buildGraphForQuestion(q);
    if (retrieval !== 'tfidf') {
      graph = await attachEmbeddings(graph, { model: embeddingModel });
    }
    const t1 = performance.now();

    const { answer, nodeCount, systemPrompt } = await answerQuestion(
      graph,
      graph.tfidfIndex,
      q.question,
      {
        model: answerModel,
        questionDate: normalizeDate(q.question_date),
        maxNodes,
        retrieval,
        embeddingIndex: graph.embeddingIndex,
        embeddingModel,
      }
    );
    const t2 = performance.now();

    const verdict = await judgeAnswer(q, answer, { model: judge });
    const t3 = performance.now();

    return {
      result: {
        ...base,
        predicted: answer,
        correct: verdict.correct,
        judgeRaw: verdict.raw,
        judgeModel: verdict.judgeModel,
        answerModel,
        nodeCount,
        ingestMs: Math.round(t1 - t0),
        answerMs: Math.round(t2 - t1),
        judgeMs: Math.round(t3 - t2),
      },
      systemPrompt,
    };
  } catch (err) {
    return {
      result: {
        ...base,
        predicted: '',
        correct: false,
        judgeRaw: '',
        judgeModel: '',
        answerModel,
        nodeCount: 0,
        ingestMs: 0,
        answerMs: 0,
        judgeMs: 0,
        error: (err as Error).message,
      },
    };
  }
}

// Simple bounded-concurrency runner: always keeps N promises in-flight.
async function runPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  onDone: (r: R, index: number) => void
): Promise<void> {
  let next = 0;
  async function lane() {
    while (true) {
      const idx = next++;
      if (idx >= items.length) return;
      const r = await worker(items[idx], idx);
      onDone(r, idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => lane()));
}

function summarize(results: QuestionResult[]) {
  const byType = new Map<string, { correct: number; total: number }>();
  let correct = 0;
  let errors = 0;
  for (const r of results) {
    const key = r.abstention ? `${r.question_type}_abs` : r.question_type;
    const bucket = byType.get(key) ?? { correct: 0, total: 0 };
    bucket.total++;
    if (r.correct) bucket.correct++;
    byType.set(key, bucket);
    if (r.correct) correct++;
    if (r.error) errors++;
  }
  const total = results.length;
  return {
    total,
    correct,
    accuracy: total > 0 ? correct / total : 0,
    errors,
    byType: Object.fromEntries(
      Array.from(byType.entries()).map(([k, v]) => [
        k,
        { correct: v.correct, total: v.total, accuracy: v.total > 0 ? v.correct / v.total : 0 },
      ])
    ),
  };
}

function writeMarkdownReport(outPath: string, args: CliArgs, results: QuestionResult[]) {
  const s = summarize(results);
  const lines: string[] = [];
  lines.push('# LongMemEval Official — Graphnosis Results');
  lines.push('');
  lines.push(`**Dataset:** \`${args.dataset}\``);
  lines.push(`**Answer model:** \`${args.answerModel}\`  **Judge model:** \`${args.judge}\``);
  lines.push(`**Questions scored:** ${s.total}  **Correct:** ${s.correct}  **Errors:** ${s.errors}`);
  lines.push('');
  lines.push(`## Overall accuracy: **${(s.accuracy * 100).toFixed(2)}%**`);
  lines.push('');
  lines.push('## By question_type');
  lines.push('');
  lines.push('| question_type | correct / total | accuracy |');
  lines.push('| --- | --- | --- |');
  for (const [type, v] of Object.entries(s.byType).sort()) {
    lines.push(`| ${type} | ${v.correct} / ${v.total} | ${(v.accuracy * 100).toFixed(2)}% |`);
  }
  lines.push('');
  lines.push('## Leaderboard context (end-to-end QA, published)');
  lines.push('');
  lines.push('| System | Score |');
  lines.push('| --- | --- |');
  lines.push('| Agentmemory V4 | 96.20% |');
  lines.push('| PwC Chronos | 95.60% |');
  lines.push('| OMEGA | 95.40% |');
  lines.push('| Mastra | 94.87% |');
  lines.push('| Supermemory | 85.86% |');
  lines.push('| Zep | 71.20% |');
  lines.push('');
  lines.push('> Comparability caveat: 100% claims by MemPalace / ZeroMemory measured retrieval recall, not end-to-end QA with the GPT-4 judge. This runner uses the official judge prompts from xiaowu0162/LongMemEval verbatim.');
  writeFileSync(outPath, lines.join('\n') + '\n', 'utf-8');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!process.env.OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY is not set. Export it before running.');
    process.exit(1);
  }

  const outDir = resolve(args.out);
  mkdirSync(outDir, { recursive: true });
  const jsonlPath = resolve(outDir, 'results.jsonl');
  const jsonPath = resolve(outDir, 'results.json');
  const mdPath = resolve(outDir, 'results.md');
  const promptsPath = resolve(outDir, 'prompts.jsonl');

  mkdirSync(dirname(jsonlPath), { recursive: true });

  const datasetPath = resolve(args.dataset);
  console.log(`[longmemeval] loading dataset ${datasetPath}`);
  const all = loadDataset(datasetPath, {
    limit: args.limit,
    typeFilter: args.types,
    seed: args.seed,
  });

  const done = loadDone(jsonlPath);
  const todo = all.filter(q => !done.has(q.question_id));
  console.log(
    `[longmemeval] ${all.length} questions selected, ${done.size} already scored, ${todo.length} to run`
  );
  console.log(
    `[longmemeval] retrieval=${args.retrieval}${args.retrieval !== 'tfidf' ? ` (${args.embeddingModel})` : ''} answer=${args.answerModel} judge=${args.judge} concurrency=${args.concurrency} maxNodes=${args.maxNodes}${args.dumpPrompts ? ' dumpPrompts' : ''}`
  );
  if (args.dumpPrompts) console.log(`[longmemeval] writing prompts to ${promptsPath}`);

  const doneResults: QuestionResult[] = [];
  if (existsSync(jsonlPath)) {
    const raw = readFileSync(jsonlPath, 'utf-8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        doneResults.push(JSON.parse(line) as QuestionResult);
      } catch {
        // ignore
      }
    }
  }

  const started = Date.now();
  let completed = 0;
  await runPool(
    todo,
    args.concurrency,
    async (q) => runOne(q, args.answerModel, args.judge, args.maxNodes, args.retrieval, args.embeddingModel),
    ({ result: r, systemPrompt }) => {
      completed++;
      appendFileSync(jsonlPath, JSON.stringify(r) + '\n', 'utf-8');
      if (args.dumpPrompts && systemPrompt !== undefined) {
        appendFileSync(
          promptsPath,
          JSON.stringify({
            question_id: r.question_id,
            question_type: r.question_type,
            correct: r.correct,
            predicted: r.predicted,
            gold: r.gold,
            systemPrompt,
          }) + '\n',
          'utf-8'
        );
      }
      doneResults.push(r);
      const pct = ((completed / todo.length) * 100).toFixed(1);
      const mark = r.correct ? '+' : r.error ? '!' : '-';
      console.log(
        `[${completed}/${todo.length} ${pct}%] ${mark} ${r.question_id} (${r.question_type}${
          r.abstention ? '/abs' : ''
        })${r.error ? ` error: ${r.error}` : ''}`
      );
    }
  );
  const elapsedS = ((Date.now() - started) / 1000).toFixed(1);

  // Keep only results that correspond to the currently-selected set (in case
  // jsonlPath had results from a prior, larger run).
  const selected = new Set(all.map(q => q.question_id));
  const relevant = doneResults.filter(r => selected.has(r.question_id));

  const summary = summarize(relevant);
  writeFileSync(jsonPath, JSON.stringify({ args, summary, results: relevant }, null, 2), 'utf-8');
  writeMarkdownReport(mdPath, args, relevant);

  console.log('');
  console.log(`[longmemeval] done in ${elapsedS}s`);
  console.log(`[longmemeval] overall: ${summary.correct}/${summary.total} = ${(summary.accuracy * 100).toFixed(2)}%`);
  for (const [type, v] of Object.entries(summary.byType).sort()) {
    console.log(`  ${type}: ${v.correct}/${v.total} = ${(v.accuracy * 100).toFixed(2)}%`);
  }
  console.log(`[longmemeval] wrote ${jsonlPath}`);
  console.log(`[longmemeval] wrote ${jsonPath}`);
  console.log(`[longmemeval] wrote ${mdPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
