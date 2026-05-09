import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';
import type { Question, JudgeOutput, Verdict } from './types';

// Judge model is pinned. Bumping requires a rubric version bump and
// re-grading every prior result file. See judge-prompt.md.
const JUDGE_MODEL = 'gpt-4o-2024-08-06';

const SYSTEM_PROMPT = [
  'You are a strict grader for a long-document QA benchmark. You will be given',
  'a question, a reference answer written by a human who read the source',
  'document, and a candidate answer produced by a system under test.',
  '',
  'Return EXACTLY one of three verdicts on the first line of your response,',
  'with no additional formatting:',
  '',
  '- correct   — the candidate conveys all of the information in the reference.',
  '              Wording may differ. Extra correct context is fine. The candidate',
  '              must not contain claims that contradict the reference.',
  '- partial   — the candidate gets part of the reference right but is missing',
  '              required information OR adds an incorrect detail that is not',
  '              central to the question. Use sparingly: when in doubt, choose wrong.',
  '- wrong     — the candidate is missing the answer, contradicts the reference,',
  '              or substitutes plausible-sounding but unsupported claims.',
  '',
  'Then, on a second line, give a one-sentence reason. No third line.',
  '',
  'Calibration:',
  '1. Numbers must match within reasonable rounding (e.g. "$60.9 billion" vs',
  '   "$60,922 million" → correct). Off by more than 1% → wrong.',
  '2. If the reference requires combining sections A and B and the candidate',
  '   only addresses A, that is partial.',
  '3. Hedging without committing to an answer → wrong.',
  '4. Naming the right section but stating no answer → wrong.',
  '5. Tier-3 inferential: mark correct if the reasoning is consistent with the',
  '   evidence cited in the reference, even if the conclusion differs in wording,',
  '   provided the candidate is not flatly contradicted by the document.',
].join('\n');

function buildUserPrompt(q: Question, candidate: string): string {
  return [
    `Question: ${q.question}`,
    '',
    'Reference answer (from human who read the document):',
    q.gold_answer,
    '',
    `Reference sections: ${q.gold_sections.join(', ')}`,
    '',
    'Candidate answer (system under test):',
    candidate,
    '',
    'Verdict (correct | partial | wrong):',
  ].join('\n');
}

export async function judgeAnswer(q: Question, candidateAnswer: string): Promise<JudgeOutput> {
  const result = await generateText({
    model: openai(JUDGE_MODEL),
    temperature: 0,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(q, candidateAnswer) },
    ],
  });

  const raw = result.text.trim();
  const verdict = parseVerdict(raw);
  const reason = raw.split('\n').slice(1).join(' ').trim() || '(no reason given)';

  return { verdict, reason, raw, judgeModel: JUDGE_MODEL };
}

function parseVerdict(raw: string): Verdict {
  const firstLine = raw.split('\n')[0]?.trim().toLowerCase() ?? '';
  if (firstLine.startsWith('correct')) return 'correct';
  if (firstLine.startsWith('partial')) return 'partial';
  if (firstLine.startsWith('wrong'))   return 'wrong';
  // Defensive fallback — log the surprise but don't crash mid-run. The
  // harness writes the raw text alongside, so re-grading is cheap.
  console.warn(`[longpdf judge] unparseable verdict: ${JSON.stringify(firstLine)}`);
  return 'wrong';
}
