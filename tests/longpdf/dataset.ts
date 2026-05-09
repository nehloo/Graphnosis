import { readFileSync } from 'node:fs';
import type { Question, DocId, Tier } from './types';

const VALID_DOCS: ReadonlySet<DocId> = new Set<DocId>([
  'filing.pdf',
  'manual.pdf',
  'paper.pdf',
]);

const VALID_TIERS: ReadonlySet<Tier> = new Set<Tier>([1, 2, 3]);

export interface LoadOptions {
  // When true, allow rows whose `gold_answer` is empty (skeleton mode).
  // The harness only permits this in --dry-run.
  allowEmptyAnswers?: boolean;
}

export function loadQuestions(path: string, opts: LoadOptions = {}): Question[] {
  const raw = readFileSync(path, 'utf8');
  const lines = raw.split('\n').filter(l => l.trim() && !l.trim().startsWith('//'));

  const seen = new Set<string>();
  const questions: Question[] = [];

  for (const [idx, line] of lines.entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new Error(`questions: line ${idx + 1} is not valid JSON: ${(err as Error).message}`);
    }

    const q = validate(parsed, idx + 1, opts);
    if (seen.has(q.id)) throw new Error(`questions: duplicate id "${q.id}" at line ${idx + 1}`);
    seen.add(q.id);
    questions.push(q);
  }

  // Sanity: 30 rows, 10 per doc, the spec mix per doc (4/4/2).
  // Soft-warn rather than throw — mid-edit skeletons will be off temporarily.
  warnDistribution(questions);

  return questions;
}

function validate(obj: unknown, lineNo: number, opts: LoadOptions): Question {
  if (typeof obj !== 'object' || obj === null) {
    throw new Error(`questions: line ${lineNo} is not an object`);
  }
  const o = obj as Record<string, unknown>;

  if (typeof o.id !== 'string' || !o.id) {
    throw new Error(`questions: line ${lineNo} missing string 'id'`);
  }
  if (typeof o.doc !== 'string' || !VALID_DOCS.has(o.doc as DocId)) {
    throw new Error(`questions: line ${lineNo} ('${o.id}') has invalid 'doc': ${String(o.doc)}`);
  }
  if (typeof o.tier !== 'number' || !VALID_TIERS.has(o.tier as Tier)) {
    throw new Error(`questions: line ${lineNo} ('${o.id}') has invalid 'tier': ${String(o.tier)}`);
  }
  if (typeof o.question !== 'string' || !o.question.trim()) {
    throw new Error(`questions: line ${lineNo} ('${o.id}') missing 'question'`);
  }
  if (!Array.isArray(o.gold_sections) || o.gold_sections.length === 0 ||
      !o.gold_sections.every(s => typeof s === 'string' && s)) {
    throw new Error(`questions: line ${lineNo} ('${o.id}') needs non-empty 'gold_sections' array of strings`);
  }
  if (typeof o.gold_answer !== 'string') {
    throw new Error(`questions: line ${lineNo} ('${o.id}') missing 'gold_answer' (use "" in skeleton mode)`);
  }
  if (!opts.allowEmptyAnswers && !o.gold_answer.trim()) {
    throw new Error(`questions: line ${lineNo} ('${o.id}') has empty 'gold_answer' — fill it in or pass --dry-run`);
  }
  if (o.notes !== undefined && typeof o.notes !== 'string') {
    throw new Error(`questions: line ${lineNo} ('${o.id}') 'notes' must be a string if present`);
  }

  return {
    id: o.id,
    doc: o.doc as DocId,
    tier: o.tier as Tier,
    question: o.question,
    gold_sections: o.gold_sections as string[],
    gold_answer: o.gold_answer,
    notes: o.notes as string | undefined,
  };
}

function warnDistribution(questions: Question[]): void {
  const expected: Record<DocId, Record<Tier, number>> = {
    'filing.pdf': { 1: 4, 2: 4, 3: 2 },
    'manual.pdf': { 1: 4, 2: 4, 3: 2 },
    'paper.pdf':  { 1: 4, 2: 4, 3: 2 },
  };
  const actual: Record<string, number> = {};
  for (const q of questions) {
    const k = `${q.doc}/${q.tier}`;
    actual[k] = (actual[k] ?? 0) + 1;
  }
  const drift: string[] = [];
  for (const doc of Object.keys(expected) as DocId[]) {
    for (const tier of [1, 2, 3] as Tier[]) {
      const want = expected[doc][tier];
      const got = actual[`${doc}/${tier}`] ?? 0;
      if (got !== want) drift.push(`${doc} tier ${tier}: ${got} (want ${want})`);
    }
  }
  if (drift.length) {
    console.warn(`[longpdf] question distribution drift:\n  ${drift.join('\n  ')}`);
  }
}
