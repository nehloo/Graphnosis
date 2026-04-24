// Loader for the real LongMemEval dataset (ICLR 2025).
// The dataset file is not shipped with the repo - users download longmemeval_s.json
// from https://huggingface.co/datasets/xiaowu0162/longmemeval and place it at
// data/longmemeval/longmemeval_s.json (see tests/longmemeval/official/README.md).

import { readFileSync, existsSync } from 'node:fs';

// Canonical definition lives in src/core/types.ts so nothing in core imports
// from tests/. Re-exported here for any existing test-side callers.
export type { LMEQuestionType } from '@/core/types';
import type { LMEQuestionType } from '@/core/types';

export interface LMETurn {
  role: 'user' | 'assistant';
  content: string;
  has_answer?: boolean;
}

export type LMESession = LMETurn[];

export interface LMEQuestion {
  question_id: string;
  question_type: LMEQuestionType;
  question: string;
  answer: string;
  question_date: string;
  haystack_session_ids: string[];
  haystack_dates: string[];
  haystack_sessions: LMESession[];
  answer_session_ids: string[];
}

export interface LoadOptions {
  limit?: number;
  typeFilter?: LMEQuestionType[];
  seed?: number;
}

// Abstention questions are flagged by a `_abs` suffix in question_id.
export function isAbstention(q: LMEQuestion): boolean {
  return q.question_id.endsWith('_abs');
}

export function loadDataset(path: string, opts: LoadOptions = {}): LMEQuestion[] {
  if (!existsSync(path)) {
    throw new Error(
      `LongMemEval dataset not found at ${path}. ` +
        `Download longmemeval_s.json from huggingface.co/datasets/xiaowu0162/longmemeval ` +
        `and place it at data/longmemeval/longmemeval_s.json.`
    );
  }

  const raw = readFileSync(path, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse ${path} as JSON: ${(err as Error).message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`Expected ${path} to contain a JSON array of questions.`);
  }

  let questions = parsed as LMEQuestion[];

  if (opts.typeFilter && opts.typeFilter.length > 0) {
    const allowed = new Set<string>(opts.typeFilter);
    questions = questions.filter(q => allowed.has(q.question_type));
  }

  if (opts.limit !== undefined && opts.limit > 0 && opts.limit < questions.length) {
    // Deterministic sampling: seeded shuffle then take first N so repeated smoke
    // runs hit the same subset (important for independence checks).
    const shuffled = seededShuffle(questions, opts.seed ?? 42);
    questions = shuffled.slice(0, opts.limit);
  }

  return questions;
}

function seededShuffle<T>(arr: T[], seed: number): T[] {
  const out = arr.slice();
  // Mulberry32 PRNG
  let s = seed >>> 0;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const r = ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
    const j = Math.floor(r * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
