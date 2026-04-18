// Multi-session miss audit for LongMemEval.
//
// Reads results.jsonl (and optionally trace.jsonl) from a run folder and
// classifies the multi-session misses into three buckets:
//
//   (a) ROUTING MISS   — router sent the question to the wrong category
//   (b) RETRIEVAL MISS — model said it couldn't find info / abstained
//   (c) COUNT ERROR    — both gold and predicted contain a number, but differ
//   (d) OTHER          — needs manual review
//
// Usage:
//   npx tsx tests/longmemeval/official/audit-multisession.ts \
//     --results data/longmemeval/results/results.jsonl \
//     [--trace   data/longmemeval/results/trace.jsonl] \
//     [--detail]

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface QuestionResult {
  question_id: string;
  question_type: string;
  abstention: boolean;
  question: string;
  gold: string;
  predicted: string;
  correct: boolean;
  detectedCategory?: string;
  nodeCount: number;
  error?: string;
}

interface TraceRow {
  question_id: string;
  ground_truth_category: string;
  detected_category?: string;
  node_type_distribution: Record<string, number>;
  correct: boolean;
  predicted: string;
  gold: string;
}

type MissBucket = 'routing' | 'retrieval' | 'count_error' | 'other';

interface MissEntry {
  question_id: string;
  question: string;
  gold: string;
  predicted: string;
  bucket: MissBucket;
  detectedCategory?: string;
  nodeCount: number;
  sessionSummaryNodes?: number;
  routingNote?: string;
}

function readJsonl<T>(path: string): T[] {
  const raw = readFileSync(path, 'utf-8');
  const rows: T[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return rows;
}

// Extract the first integer or decimal number from a string.
function extractNumber(s: unknown): number | null {
  if (typeof s !== 'string') return null;
  const m = s.match(/\b(\d+(?:\.\d+)?)\b/);
  return m ? parseFloat(m[1]) : null;
}

// Is the predicted answer a "no context" / retrieval failure response?
const RETRIEVAL_FAIL =
  /\b(don'?t have|doesn'?t (contain|include)|no (relevant|specific|direct)|not (found|mentioned|available|present|enough|sufficient)|cannot (find|determine|answer)|could not (find|determine)|context (does not|doesn't)|no information|i('m| am) unable|not in the (context|graph|provided))\b/i;

function classifyMiss(r: QuestionResult, trace?: TraceRow): MissEntry {
  const detectedCategory = r.detectedCategory ?? trace?.detected_category;

  // (a) Routing miss: question was not classified as multi-session
  const isRoutingMiss =
    detectedCategory !== undefined && detectedCategory !== 'multi-session';

  // (b) Retrieval miss: predicted contains a "couldn't find" phrase
  const isRetrievalMiss = RETRIEVAL_FAIL.test(r.predicted);

  // (c) Count error: gold has a number, predicted has a number, they differ
  const goldNum = extractNumber(r.gold);
  const predNum = extractNumber(r.predicted);
  const isCountError =
    goldNum !== null && predNum !== null && goldNum !== predNum;

  let bucket: MissBucket;
  if (isRoutingMiss) bucket = 'routing';
  else if (isRetrievalMiss) bucket = 'retrieval';
  else if (isCountError) bucket = 'count_error';
  else bucket = 'other';

  const sessionSummaryNodes = trace?.node_type_distribution?.['session-summary'];

  return {
    question_id: r.question_id,
    question: r.question,
    gold: r.gold,
    predicted: r.predicted,
    bucket,
    detectedCategory,
    nodeCount: r.nodeCount,
    sessionSummaryNodes,
    routingNote: isRoutingMiss
      ? `routed to '${detectedCategory}' instead of 'multi-session'`
      : undefined,
  };
}

function parseArgs(argv: string[]): { results: string; trace?: string; detail: boolean } {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { args[key] = next; i++; }
      else args[key] = 'true';
    }
  }
  return {
    results: args.results ?? 'data/longmemeval/results/results.jsonl',
    trace: args.trace,
    detail: args.detail === 'true',
  };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const resultsPath = resolve(opts.results);

  if (!existsSync(resultsPath)) {
    console.error(`Results file not found: ${resultsPath}`);
    console.error('Pass --results <path/to/results.jsonl>');
    process.exit(1);
  }

  const results = readJsonl<QuestionResult>(resultsPath);
  const traceMap = new Map<string, TraceRow>();
  if (opts.trace) {
    const tracePath = resolve(opts.trace);
    if (existsSync(tracePath)) {
      for (const row of readJsonl<TraceRow>(tracePath)) {
        traceMap.set(row.question_id, row);
      }
      console.log(`Loaded ${traceMap.size} trace rows from ${tracePath}`);
    } else {
      console.warn(`Trace file not found: ${tracePath} (continuing without it)`);
    }
  }

  // Filter to multi-session misses only
  const multiResults = results.filter(r => r.question_type === 'multi-session');
  const misses = multiResults.filter(r => !r.correct && !r.error);
  const wins = multiResults.filter(r => r.correct);

  console.log('');
  console.log('=== MULTI-SESSION AUDIT ===');
  console.log(`Total multi-session questions: ${multiResults.length}`);
  console.log(`  Correct: ${wins.length} (${(wins.length / multiResults.length * 100).toFixed(1)}%)`);
  console.log(`  Missed:  ${misses.length} (${(misses.length / multiResults.length * 100).toFixed(1)}%)`);
  console.log(`  Overall accuracy impact: ${(misses.length / results.length * 100).toFixed(1)}pt headroom`);
  console.log('');

  if (misses.length === 0) {
    console.log('No misses — nothing to audit.');
    return;
  }

  const entries = misses.map(r => classifyMiss(r, traceMap.get(r.question_id)));

  // Bucket summary
  const buckets = {
    routing: entries.filter(e => e.bucket === 'routing'),
    retrieval: entries.filter(e => e.bucket === 'retrieval'),
    count_error: entries.filter(e => e.bucket === 'count_error'),
    other: entries.filter(e => e.bucket === 'other'),
  };

  console.log('--- BUCKET BREAKDOWN ---');
  console.log(`(a) Routing miss   : ${buckets.routing.length} (${pct(buckets.routing.length, misses.length)})`);
  console.log(`(b) Retrieval miss : ${buckets.retrieval.length} (${pct(buckets.retrieval.length, misses.length)})`);
  console.log(`(c) Count error    : ${buckets.count_error.length} (${pct(buckets.count_error.length, misses.length)})`);
  console.log(`(d) Other          : ${buckets.other.length} (${pct(buckets.other.length, misses.length)})`);
  console.log('');

  if (traceMap.size > 0) {
    // Session summary coverage stats
    const withSummaries = entries.filter(e => (e.sessionSummaryNodes ?? 0) > 0);
    const withoutSummaries = entries.filter(e => (e.sessionSummaryNodes ?? 0) === 0);
    console.log('--- SESSION SUMMARY COVERAGE ---');
    console.log(`Misses with ≥1 summary node in context : ${withSummaries.length} (${pct(withSummaries.length, misses.length)})`);
    console.log(`Misses with 0 summary nodes in context : ${withoutSummaries.length} (${pct(withoutSummaries.length, misses.length)})`);
    const avgNodeCount = entries.reduce((s, e) => s + e.nodeCount, 0) / entries.length;
    console.log(`Avg node count in missed questions     : ${avgNodeCount.toFixed(1)}`);
    console.log('');
  }

  // Count error analysis
  if (buckets.count_error.length > 0) {
    const goldNums = buckets.count_error.map(e => extractNumber(e.gold) ?? 0);
    const predNums = buckets.count_error.map(e => extractNumber(e.predicted) ?? 0);
    const diffs = goldNums.map((g, i) => predNums[i] - g);
    const undercount = diffs.filter(d => d < 0).length;
    const overcount = diffs.filter(d => d > 0).length;
    console.log('--- COUNT ERROR BREAKDOWN ---');
    console.log(`LLM undercounted (predicted < gold): ${undercount} (${pct(undercount, buckets.count_error.length)})`);
    console.log(`LLM overcounted  (predicted > gold): ${overcount} (${pct(overcount, buckets.count_error.length)})`);
    const avgDiff = diffs.reduce((a, b) => a + b, 0) / diffs.length;
    console.log(`Average offset (predicted - gold)  : ${avgDiff > 0 ? '+' : ''}${avgDiff.toFixed(1)}`);
    console.log('');
  }

  // Detailed per-question output
  if (opts.detail) {
    for (const [label, bucket] of Object.entries(buckets) as [string, MissEntry[]][]) {
      if (bucket.length === 0) continue;
      console.log(`=== (${label.toUpperCase()}) ${bucket.length} questions ===`);
      for (const e of bucket) {
        console.log(`\n  [${e.question_id}]`);
        console.log(`  Q: ${e.question}`);
        console.log(`  Gold:      ${e.gold}`);
        console.log(`  Predicted: ${e.predicted.slice(0, 200)}${e.predicted.length > 200 ? '…' : ''}`);
        if (e.routingNote) console.log(`  Note: ${e.routingNote}`);
        if (e.sessionSummaryNodes !== undefined)
          console.log(`  Summary nodes in context: ${e.sessionSummaryNodes}, total nodes: ${e.nodeCount}`);
      }
      console.log('');
    }
  } else {
    console.log('(Pass --detail to see per-question breakdown)');
  }

  // Fix suggestions
  console.log('--- SUGGESTED FIXES ---');
  if (buckets.routing.length > 0) {
    console.log(`• ${buckets.routing.length} routing misses → check AGGREGATION_INTENT regex in router.ts`);
    const wrongCategories = new Map<string, number>();
    for (const e of buckets.routing) {
      const cat = e.detectedCategory ?? 'unknown';
      wrongCategories.set(cat, (wrongCategories.get(cat) ?? 0) + 1);
    }
    for (const [cat, n] of wrongCategories.entries()) {
      console.log(`    ${n} routed to '${cat}'`);
    }
  }
  if (buckets.retrieval.length > 0) {
    console.log(`• ${buckets.retrieval.length} retrieval misses → increase maxSeeds/maxNodes or widen diversification`);
  }
  if (buckets.count_error.length > 0) {
    const diffs = buckets.count_error.map(e => (extractNumber(e.predicted) ?? 0) - (extractNumber(e.gold) ?? 0));
    const avgDiff = diffs.reduce((a, b) => a + b, 0) / diffs.length;
    if (avgDiff < 0) {
      console.log(`• ${buckets.count_error.length} count errors (avg ${avgDiff.toFixed(1)} undercounted) → improve retrieval coverage, expose session claims in serializer`);
    } else {
      console.log(`• ${buckets.count_error.length} count errors (avg +${avgDiff.toFixed(1)} overcounted) → tighten aggregation prompt criterion matching`);
    }
  }
  if (buckets.other.length > 0) {
    console.log(`• ${buckets.other.length} 'other' misses → run with --detail and inspect manually`);
  }
}

function pct(n: number, total: number): string {
  return total === 0 ? '0%' : `${(n / total * 100).toFixed(0)}%`;
}

main();
