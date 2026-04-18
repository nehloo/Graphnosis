// Phase 3: query-time preference extraction for LongMemEval
// single-session-preference questions.
//
// Preference questions ask the assistant to make a recommendation that
// reflects known user tastes ("Can you suggest a hotel for my trip to
// Miami?"). The retrieval layer already surfaces the right session(s), but
// the preference signals themselves are typically scattered across many
// small mentions rather than stated as a single fact. When the prompt
// carries raw turn evidence alone, the answer model often over-generalizes
// or grounds in assistant recommendations from past sessions instead of the
// user's own statements.
//
// This pass walks the haystack sessions, calls gpt-4o-mini once per
// session, and asks it to extract every user-voice statement relevant to
// the question. The extracted statements are injected into the answer
// prompt as a dedicated `--- USER PREFERENCE STATEMENTS ---` block ahead
// of the turn evidence — a distilled, citation-ready source that the
// preference-category prompt block already tells the model to prioritize.
//
// Cost model: ~30 preference-classified questions × ~50 sessions ×
// ~$0.0005/call = ~$0.75 per cold 500q run. Cache key is
// hash(question + session_content) so repeat runs pay near-zero.

import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';
import type { ParsedDocument, ConversationMessage } from '@/core/types';
import { readCache, writeCache, hashContent } from './enrichment-cache';

export interface PreferenceStatement {
  // User-voice claim relevant to the question, e.g. "I prefer window seats"
  // or "I'm allergic to shellfish". Preserved in the user's own phrasing so
  // the answer model can quote or paraphrase faithfully.
  text: string;
  sessionId?: string;
  sessionDate?: string;
  // Optional turn index the statement came from. Mostly cosmetic — gives the
  // answer model a citation-ready tag.
  turn?: number;
}

export interface ExtractPreferencesOptions {
  model?: string; // defaults to gpt-4o-mini
  useCache?: boolean; // defaults to true
  // Lane-pool concurrency across sessions. The OpenAI per-org rate limits
  // comfortably absorb 6 concurrent gpt-4o-mini calls.
  concurrency?: number;
  // Progress ping after each session completes — lets the CLI print a live
  // "extracted X/Y" line.
  onProgress?: (done: number, total: number, cacheHits: number) => void;
}

export interface ExtractPreferencesResult {
  statements: PreferenceStatement[];
  cacheHits: number;
  llmCalls: number;
  failures: number;
}

function buildExtractionPrompt(
  question: string,
  sessionDate: string,
  turns: ConversationMessage[]
): string {
  const transcript = turns
    .map((t, i) => `[${i + 1}] ${t.role}: ${t.content}`)
    .join('\n');

  return `You are extracting the SHORTLIST of user statements from a chat session that would change the answer to a specific question.

QUESTION: ${question}

SESSION DATE: ${sessionDate || 'unknown'}

TRANSCRIPT:
${transcript}

Return AT MOST 3 statements. Prefer zero over loose matches. A statement qualifies only if omitting it would make the recommendation worse or wrong.

Qualifying:
- A concrete user preference, constraint, dislike, allergy, or prior choice that narrows the recommendation (e.g., "I'm allergic to shellfish" for a restaurant question).
- A fact about the user's situation that the recommender must respect (e.g., "I don't own a car" for a trip question).

Disqualifying — DO NOT extract:
- Generic habits or routines unrelated to the question ("I usually wake up at 7").
- Past assistant suggestions, even when the user engaged with them.
- World facts, definitions, or third-party statements.
- Restatements of the current question.
- Statements from a different topic than the question.
- Filler like "that sounds good" or "thanks".

If fewer than 3 statements qualify, return fewer. If none qualify, return an empty list — this is the correct answer for most sessions.

Voice rules:
- Preserve the user's first-person voice ("I prefer X"), not third-person paraphrase.
- Each statement must be self-contained (readable without the transcript).

Respond with ONLY valid JSON, no markdown:
{
  "statements": [
    { "text": "I prefer X", "turn": 3 }
  ]
}`;
}

interface ParsedExtraction {
  statements: Array<{ text: string; turn?: number }>;
}

function parseResponse(raw: string): ParsedExtraction | null {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed.statements)) return null;
    return {
      statements: parsed.statements
        .filter((s: unknown): s is { text: string; turn?: number } => {
          return (
            typeof s === 'object' &&
            s !== null &&
            typeof (s as { text: unknown }).text === 'string'
          );
        })
        .map((s: { text: string; turn?: number }) => ({
          text: s.text,
          turn: typeof s.turn === 'number' ? s.turn : undefined,
        })),
    };
  } catch {
    return null;
  }
}

function docToMessages(doc: ParsedDocument): ConversationMessage[] {
  return doc.sections.map(s => {
    const role = s.title.startsWith('User') ? 'user' : 'assistant';
    return { role: role as 'user' | 'assistant', content: s.content };
  });
}

// Prompt version. Bump when the extraction prompt changes so cache entries
// from older prompt versions don't leak into fresh runs. Last bumped when
// the prompt was tightened (cap=3, strict disqualifiers) — see Run 21 post-
// mortem: without a version field the cache served stale permissive
// extractions and the 500q re-run was a no-op.
const PROMPT_VERSION = 'v2-strict-cap3';

// Cache key mixes the question text, session content, and prompt version so
// (a) identical sessions across questions still get distinct cache entries
// and (b) prompt changes invalidate cleanly.
function cacheKey(question: string, sessionDate: string, turns: ConversationMessage[]): string {
  const payload =
    PROMPT_VERSION +
    '||' +
    question +
    '||' +
    sessionDate +
    '||' +
    turns.map(t => `${t.role}:${t.content}`).join('\n');
  return hashContent(payload);
}

export async function extractPreferences(
  question: string,
  docs: ParsedDocument[],
  opts: ExtractPreferencesOptions = {}
): Promise<ExtractPreferencesResult> {
  const model = opts.model ?? 'gpt-4o-mini';
  const useCache = opts.useCache !== false;
  const concurrency = Math.max(1, opts.concurrency ?? 6);

  // Prepare per-session work items. Empty sessions (no turns) are skipped —
  // nothing to extract.
  interface WorkItem {
    doc: ParsedDocument;
    sessionId: string;
    sessionDate: string;
    messages: ConversationMessage[];
    hash: string;
  }
  const items: WorkItem[] = [];
  for (const doc of docs) {
    const messages = docToMessages(doc);
    if (messages.length === 0) continue;
    const sessionId = String(doc.metadata.sessionId ?? '');
    const sessionDate = String(doc.metadata.sessionDate ?? '');
    items.push({
      doc,
      sessionId,
      sessionDate,
      messages,
      hash: cacheKey(question, sessionDate, messages),
    });
  }

  const statements: PreferenceStatement[] = [];
  let cacheHits = 0;
  let llmCalls = 0;
  let failures = 0;
  let done = 0;
  const total = items.length;

  // True lane pool — same pattern as session-summarizer. Keeps throughput
  // up when a single gpt-4o-mini call stalls.
  let cursor = 0;
  async function lane(): Promise<void> {
    while (cursor < items.length) {
      const myIdx = cursor++;
      const item = items[myIdx];

      let extracted: ParsedExtraction | null = null;
      let fromCache = false;
      if (useCache) {
        const cached = await readCache<ParsedExtraction>('preference-extraction', item.hash);
        if (cached) {
          extracted = cached;
          fromCache = true;
        }
      }

      if (!extracted) {
        try {
          const result = await generateText({
            model: openai(model),
            prompt: buildExtractionPrompt(question, item.sessionDate, item.messages),
          });
          extracted = parseResponse(result.text);
          if (extracted && useCache) {
            await writeCache('preference-extraction', item.hash, extracted);
          }
        } catch {
          extracted = null;
        }
      }

      done++;
      if (fromCache) cacheHits++;
      else if (extracted) llmCalls++;
      if (!extracted) {
        failures++;
      } else {
        for (const s of extracted.statements) {
          statements.push({
            text: s.text,
            sessionId: item.sessionId || undefined,
            sessionDate: item.sessionDate || undefined,
            turn: s.turn,
          });
        }
      }

      if (opts.onProgress) opts.onProgress(done, total, cacheHits);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => lane())
  );

  return { statements, cacheHits, llmCalls, failures };
}

// Render extracted statements as a prompt block. Designed to be prepended
// to the serialized subgraph so the answer model sees preference evidence
// ahead of turn evidence. Empty input → empty string so the caller can
// unconditionally concatenate.
export function renderPreferenceBlock(statements: PreferenceStatement[]): string {
  if (statements.length === 0) return '';
  const lines: string[] = [];
  lines.push('--- USER PREFERENCE STATEMENTS ---');
  lines.push(
    '(Distilled user-voice statements extracted from the haystack sessions. Prefer these when grounding preference-type answers.)'
  );
  for (const s of statements) {
    const tags: string[] = [];
    if (s.sessionId) tags.push(`session:${s.sessionId}`);
    if (s.sessionDate) tags.push(`date:${s.sessionDate}`);
    if (typeof s.turn === 'number') tags.push(`turn:${s.turn}`);
    const tagStr = tags.length > 0 ? ` [${tags.join('|')}]` : '';
    lines.push(`- ${s.text}${tagStr}`);
  }
  lines.push('');
  return lines.join('\n') + '\n';
}
