// Long-PDF benchmark entrypoint.
//
// Usage:
//   tsx tests/longpdf/harness.ts --questions tests/longpdf/questions.local.jsonl --dry-run
//   tsx tests/longpdf/harness.ts --questions tests/longpdf/questions.local.jsonl
//   tsx tests/longpdf/harness.ts --questions ... --baselines hippocortex,embedding-rag --only filing.pdf
//
// Default is INERT: --dry-run is implied unless you pass --confirm.
// This makes accidental runs free — the harness will not call the judge or
// any answer-synthesis path until you explicitly opt in.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { loadQuestions } from './dataset';
import { judgeAnswer } from './judge';
import { scoreRun, summarize, summaryToMarkdown } from './score';
import * as hippocortexBaseline from './baselines/hippocortex';
import * as embeddingBaseline from './baselines/embedding-rag';
import type { Question, BaselineRun, ScoredQuestion, DocId } from './types';

interface Args {
  questions: string;
  baselines: Array<'hippocortex' | 'embedding-rag'>;
  only?: DocId;
  confirm: boolean;
  outDir: string;
}

function parseArgs(argv: string[]): Args {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { out[k] = next; i++; }
      else out[k] = 'true';
    }
  }
  if (!out.questions) {
    throw new Error('Missing --questions <path>. Try tests/longpdf/questions.local.jsonl.');
  }
  const baselines = (out.baselines ?? 'hippocortex,embedding-rag')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean) as Args['baselines'];
  for (const b of baselines) {
    if (b !== 'hippocortex' && b !== 'embedding-rag') {
      throw new Error(`Unknown baseline: ${b}`);
    }
  }
  const dryRun = out['dry-run'] === 'true';
  const confirm = out.confirm === 'true';
  // Default: dry-run UNLESS the user explicitly confirms a real run.
  const isReal = confirm && !dryRun;
  return {
    questions: out.questions,
    baselines,
    only: (out.only as DocId | undefined),
    confirm: isReal,
    outDir: out.out ?? 'tests/longpdf/results',
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const allowEmptyAnswers = !args.confirm; // skeleton mode is fine in dry-run
  const questions = loadQuestions(args.questions, { allowEmptyAnswers })
    .filter(q => !args.only || q.doc === args.only);

  console.log(`[longpdf] loaded ${questions.length} questions from ${args.questions}`);
  console.log(`[longpdf] mode: ${args.confirm ? 'REAL (judge + answer synthesis)' : 'DRY-RUN (retrieval only, no LLM calls)'}`);
  console.log(`[longpdf] baselines: ${args.baselines.join(', ')}`);

  if (args.confirm && process.env.OPENAI_API_KEY === undefined) {
    throw new Error('Real run requires OPENAI_API_KEY in env.');
  }

  // Verify corpus checksums if present — pin runs to specific document bytes.
  verifyChecksums();

  const runs: BaselineRun[] = [];
  for (const baseline of args.baselines) {
    const impl = baseline === 'hippocortex' ? hippocortexBaseline : embeddingBaseline;
    console.log(`\n[longpdf] === ${baseline} ===`);
    for (const q of questions) {
      try {
        const r = await impl.run(q, { dryRun: !args.confirm });
        runs.push(r);
        process.stdout.write(`  ${q.id} (${r.candidates.length} cand, ${r.latencyMs}ms)\n`);
      } catch (err) {
        console.error(`  ${q.id} FAILED: ${(err as Error).message}`);
      }
    }
  }

  // Score retrieval@k for everyone. Judge calls only happen on confirmed runs.
  const scored: ScoredQuestion[] = [];
  const qById = new Map(questions.map(q => [q.id, q]));

  for (const r of runs) {
    const q = qById.get(r.questionId);
    if (!q) continue;
    let judge: ScoredQuestion['judge'];
    if (args.confirm && r.answer) {
      judge = await judgeAnswer(q, r.answer);
      console.log(`  judge ${r.questionId}: ${judge.verdict}`);
    } else {
      judge = { verdict: 'wrong', reason: 'dry-run; not judged', raw: '', judgeModel: '(none)' };
    }
    scored.push({ ...scoreRun(r, q, judge), questionId: `${r.baseline}/${r.questionId}` });
  }

  // Build summaries per baseline.
  const summaries = args.baselines.map(b => {
    const subset = scored.filter(s => s.questionId.startsWith(`${b}/`));
    return summarize(subset, b, 20);
  });

  // Persist.
  const stamp = new Date().toISOString().slice(0, 10);
  const dir = join(args.outDir, stamp);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'runs.jsonl'), runs.map(r => JSON.stringify(r)).join('\n') + '\n');
  writeFileSync(join(dir, 'scored.jsonl'), scored.map(s => JSON.stringify(s)).join('\n') + '\n');
  const md = [
    `# Long-PDF benchmark — ${stamp}`,
    '',
    `Mode: **${args.confirm ? 'REAL' : 'DRY-RUN'}** · Questions: ${questions.length}`,
    '',
    ...summaries.map(summaryToMarkdown),
    '',
  ].join('\n\n');
  writeFileSync(join(dir, 'summary.md'), md);

  console.log(`\n[longpdf] wrote ${dir}`);
  if (!args.confirm) {
    console.log('[longpdf] DRY-RUN: no judge calls were made. Re-run with --confirm to grade.');
  }
}

function verifyChecksums(): void {
  const path = 'tests/longpdf/corpus/CHECKSUMS.txt';
  if (!existsSync(path)) {
    console.warn('[longpdf] no corpus/CHECKSUMS.txt — runs are not pinned to document bytes.');
    return;
  }
  const lines = readFileSync(path, 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    const m = line.match(/^([0-9a-f]{64})\s+(.+)$/i);
    if (!m) continue;
    const [, expected, name] = m;
    const file = join('tests/longpdf/corpus', name.replace(/^corpus\//, ''));
    if (!existsSync(file)) {
      throw new Error(`checksum: ${file} listed in CHECKSUMS.txt but missing on disk`);
    }
    const actual = createHash('sha256').update(readFileSync(file)).digest('hex');
    if (actual !== expected.toLowerCase()) {
      throw new Error(`checksum mismatch for ${file}: expected ${expected}, got ${actual}`);
    }
  }
  console.log(`[longpdf] checksums verified (${lines.length} files)`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
