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

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync, renameSync } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';
import { performance } from 'node:perf_hooks';
import { loadDataset, isAbstention, type LMEQuestion, type LMEQuestionType } from './dataset';
import { buildGraphForQuestion, buildSessionDocsForQuestion, normalizeDate } from './ingest';
import { judgeAnswer, type JudgeModel } from './judge';
import { answerQuestion, type RetrievalMode } from '@/core/query/answer';
import { attachEmbeddings, buildGraph } from '@/core/graph/graph-builder';
import { enrichSessionGraph } from '@/core/enrichment/session-summarizer';

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
  // Phase 1 — question-type router. Off by default so this run is A/B-able
  // against Run 14 (same pipeline, same prompt blocks). When on, the query
  // engine classifies the question from text and dispatches to a per-category
  // retrieval strategy + prompt block.
  enableRouter: boolean;
  // Phase 2 — per-session compressed summaries. When on, after building the
  // per-question graph we call the LLM to produce one summary node per
  // session and wire a 'summarizes' edge to each turn. Router-gated at
  // retrieval time so single-session questions don't get displaced.
  enableSessionSummaries: boolean;
  // Phase 3 — query-time preference extraction. When on, questions the
  // router classifies as single-session-preference get a fan-out LLM pass
  // over the haystack sessions to distill user-voice preference statements,
  // which are injected into the answer prompt ahead of the turn evidence.
  // Requires --enable-router (the router is what decides whether to fire).
  enablePreferenceExtraction: boolean;
  // Writes one JSONL line per question with detected category, strategy
  // values, and node-type distribution in the prompt. Used for debugging
  // router regressions (e.g. summary nodes leaking into single-session-user).
  trace: boolean;
  // After the run completes, rename args.out → a sibling folder whose name
  // encodes run number, accuracy, and the active flags. Follows the
  // convention established by earlier runs:
  //   "results {N} - {score}% {mode} {tier} {flags}"
  // Disabled by default so incremental re-runs of the same out-dir still
  // work (rename breaks the `loadDone` resume path).
  labelRun: boolean;
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
    // text-embedding-3-small). The full 500-question run embeds ~75M
    // tokens total - above 1M/min sustained is impossible, so run
    // serially. TF-IDF has no such limit and stays at 4.
    concurrency: args.concurrency
      ? parseInt(args.concurrency, 10)
      : (args.retrieval && args.retrieval !== 'tfidf' ? 1 : 4),
    seed: args.seed ? parseInt(args.seed, 10) : 42,
    maxNodes: args['max-nodes'] ? parseInt(args['max-nodes'], 10) : 30,
    dumpPrompts: args['dump-prompts'] === 'true',
    retrieval: ((args.retrieval ?? 'tfidf') as RetrievalMode),
    embeddingModel: args['embedding-model'] ?? 'text-embedding-3-small',
    enableRouter: args['enable-router'] === 'true',
    enableSessionSummaries: args['enable-session-summaries'] === 'true',
    enablePreferenceExtraction: args['enable-preference-extraction'] === 'true',
    trace: args.trace === 'true',
    labelRun: args['label-run'] === 'true',
  };
}

// Pick the next run number by scanning sibling folders named
// "results N ...". Returns max(N) + 1, or 1 if none exist.
function nextRunNumber(parentDir: string): number {
  let max = 0;
  try {
    for (const name of readdirSync(parentDir)) {
      const m = name.match(/^results\s+(\d+)\b/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (Number.isFinite(n) && n > max) max = n;
      }
    }
  } catch {
    // parentDir doesn't exist yet — fine, first run
  }
  return max + 1;
}

// Build the descriptive suffix for this run. Mirrors the conventions
// visible in existing folders (e.g. "14 - 72.20 real premium - took over Zep",
// "7 - first embedded smoke hybrid"). Returns just the suffix — caller
// prepends "results N - ".
function describeRun(
  args: CliArgs,
  totalQuestions: number,
  accuracy: number
): string {
  const parts: string[] = [];
  parts.push(`${(accuracy * 100).toFixed(2)}%`);

  // Mode: smoke (limit ≤ 50) vs real (no limit or ≥ 100).
  const isSmoke = args.limit !== undefined && args.limit <= 50;
  parts.push(isSmoke ? 'smoke' : 'real');

  // Tier: "premium" matches the :premium npm scripts (gpt-4o + hybrid).
  const premium =
    args.answerModel === 'gpt-4o' && args.retrieval === 'hybrid';
  if (premium) parts.push('premium');
  else parts.push(`${args.answerModel}-${args.retrieval}`);

  // Flags. Keep short tokens that match how we talk about runs in
  // benchmarks.md — "router", "summaries", "prefs", etc.
  const flags: string[] = [];
  if (args.enableRouter) flags.push('router');
  if (args.enableSessionSummaries) flags.push('summaries');
  if (args.enablePreferenceExtraction) flags.push('prefs');
  if (flags.length > 0) parts.push(flags.join('+'));

  // Optional n tag when limit was explicitly set and differs from defaults.
  if (args.limit !== undefined && args.limit !== 20 && args.limit !== 500) {
    parts.push(`n=${totalQuestions}`);
  }

  return parts.join(' ');
}

// Rename args.out to a descriptive sibling folder. Safe across already-
// named folders by suffixing a counter if the target exists.
function labelRunDir(
  outPath: string,
  args: CliArgs,
  totalQuestions: number,
  accuracy: number
): string | null {
  if (!existsSync(outPath)) return null;
  const parent = dirname(outPath);
  const runNumber = nextRunNumber(parent);
  const suffix = describeRun(args, totalQuestions, accuracy);
  let target = resolve(parent, `results ${runNumber} - ${suffix}`);
  let dedup = 2;
  while (existsSync(target)) {
    target = resolve(parent, `results ${runNumber} - ${suffix} (${dedup})`);
    dedup++;
  }
  renameSync(outPath, target);
  return target;
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
  // Router telemetry (present when --enable-router is set). Stored on the
  // result row so per-category accuracy can be cross-tabulated against
  // detected category, not just the ground-truth label.
  detectedCategory?: LMEQuestionType;
  routerSource?: 'regex' | 'explicit';
  // Phase 3 telemetry: populated when --enable-preference-extraction ran
  // on this question. Lets us audit which preference questions got a
  // non-empty statement block vs fell back to raw turn evidence.
  preferenceStatementCount?: number;
  preferenceCacheHits?: number;
  preferenceLlmCalls?: number;
}

interface TraceRow {
  question_id: string;
  ground_truth_category: LMEQuestionType;
  detected_category?: LMEQuestionType;
  router_source?: 'regex' | 'explicit';
  strategy?: {
    maxSeeds: number;
    maxNodes: number;
    diversifyByFile: boolean;
    preferSummarySeeds?: boolean;
    preferPreferenceInjection?: boolean;
  };
  node_type_distribution: Record<string, number>;
  correct: boolean;
  predicted: string;
  gold: string;
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
  embeddingModel: string,
  enableRouter: boolean,
  enableSessionSummaries: boolean,
  enablePreferenceExtraction: boolean
): Promise<{ result: QuestionResult; systemPrompt?: string; trace?: TraceRow }> {
  const base = {
    question_id: q.question_id,
    question_type: q.question_type,
    abstention: isAbstention(q),
    question: q.question,
    gold: q.answer,
  };

  try {
    const t0 = performance.now();
    // Build the per-question graph. If summaries are enabled we need the
    // session docs as well, so we inline the buildGraphForQuestion work
    // here to avoid reconstructing docs twice.
    const docs = buildSessionDocsForQuestion(q);
    let graph = buildGraph(docs, `lme:${q.question_id}`);
    if (enableSessionSummaries) {
      let lastLog = 0;
      await enrichSessionGraph(graph, docs, {
        onProgress: (done, total, cacheHits) => {
          const now = Date.now();
          // Throttle to one line every 2s or on the final tick so we don't
          // spam stdout but still confirm the process is alive.
          if (now - lastLog < 2000 && done !== total) return;
          lastLog = now;
          process.stdout.write(
            `  [summarize] ${q.question_id}: ${done}/${total} (${cacheHits} cached)\r`
          );
          if (done === total) process.stdout.write('\n');
        },
      });
    }
    if (retrieval !== 'tfidf') {
      graph = await attachEmbeddings(graph, { model: embeddingModel });
    }
    const t1 = performance.now();

    const { answer, nodeCount, systemPrompt, subgraph, router, preferences } = await answerQuestion(
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
        useRouter: enableRouter,
        enablePreferenceExtraction,
        documents: enablePreferenceExtraction ? docs : undefined,
      }
    );
    const t2 = performance.now();

    const verdict = await judgeAnswer(q, answer, { model: judge });
    const t3 = performance.now();

    // Node-type distribution across the retrieved subgraph. Helps diagnose
    // router regressions (e.g. summary nodes dominating a single-session-user
    // prompt) before we even look at per-question accuracy.
    const dist: Record<string, number> = {};
    for (const n of subgraph.nodes) {
      dist[n.type] = (dist[n.type] ?? 0) + 1;
    }

    const trace: TraceRow = {
      question_id: q.question_id,
      ground_truth_category: q.question_type,
      detected_category: router?.category,
      router_source: router?.source,
      strategy: router
        ? {
            maxSeeds: router.strategy.maxSeeds,
            maxNodes: router.strategy.maxNodes,
            diversifyByFile: router.strategy.diversifyByFile,
            preferSummarySeeds: router.strategy.preferSummarySeeds,
            preferPreferenceInjection: router.strategy.preferPreferenceInjection,
          }
        : undefined,
      node_type_distribution: dist,
      correct: verdict.correct,
      predicted: answer,
      gold: q.answer,
    };

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
        detectedCategory: router?.category,
        routerSource: router?.source,
        preferenceStatementCount: preferences?.statements.length,
        preferenceCacheHits: preferences?.cacheHits,
        preferenceLlmCalls: preferences?.llmCalls,
      },
      systemPrompt,
      trace,
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
  const tracePath = resolve(outDir, 'trace.jsonl');

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
    `[longmemeval] retrieval=${args.retrieval}${args.retrieval !== 'tfidf' ? ` (${args.embeddingModel})` : ''} answer=${args.answerModel} judge=${args.judge} concurrency=${args.concurrency} maxNodes=${args.maxNodes}${args.enableRouter ? ' router' : ''}${args.enableSessionSummaries ? ' summaries' : ''}${args.enablePreferenceExtraction ? ' prefs' : ''}${args.trace ? ' trace' : ''}${args.dumpPrompts ? ' dumpPrompts' : ''}`
  );
  if (args.dumpPrompts) console.log(`[longmemeval] writing prompts to ${promptsPath}`);
  if (args.trace) console.log(`[longmemeval] writing trace to ${tracePath}`);

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
    async (q) => runOne(q, args.answerModel, args.judge, args.maxNodes, args.retrieval, args.embeddingModel, args.enableRouter, args.enableSessionSummaries, args.enablePreferenceExtraction),
    ({ result: r, systemPrompt, trace }) => {
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
      if (args.trace && trace) {
        appendFileSync(tracePath, JSON.stringify(trace) + '\n', 'utf-8');
      }
      doneResults.push(r);
      const pct = ((completed / todo.length) * 100).toFixed(1);
      const mark = r.correct ? '+' : r.error ? '!' : '-';
      const routeTag = r.detectedCategory ? ` [${r.detectedCategory}]` : '';
      console.log(
        `[${completed}/${todo.length} ${pct}%] ${mark} ${r.question_id} (${r.question_type}${
          r.abstention ? '/abs' : ''
        })${routeTag}${r.error ? ` error: ${r.error}` : ''}`
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

  // Descriptive label for the run folder. Always print a suggestion so you
  // can rename manually; actually perform the rename only with --label-run.
  const parent = dirname(outDir);
  const runNumber = nextRunNumber(parent);
  const suffix = describeRun(args, summary.total, summary.accuracy);
  const suggested = `results ${runNumber} - ${suffix}`;
  console.log('');
  console.log(`[longmemeval] suggested folder name: "${suggested}"`);
  if (args.labelRun) {
    const renamed = labelRunDir(outDir, args, summary.total, summary.accuracy);
    if (renamed) {
      console.log(`[longmemeval] renamed ${basename(outDir)} → ${basename(renamed)}`);
    }
  } else {
    console.log(
      `[longmemeval] (pass --label-run to auto-rename "${basename(outDir)}" → "${suggested}")`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
