// Build a per-question knowledge graph from a LongMemEval haystack.
//
// Each question ships with ~50 chat sessions of haystack. We turn each session
// into a ParsedDocument (reusing conversationToDocument) and build a fresh,
// isolated KnowledgeGraph so there's no cross-question contamination.

import type { ParsedDocument, ParsedConversation } from '@/core/types';
import { conversationToDocument } from '@/core/ingestion/parsers/conversation-parser';
import { buildGraph, type BuiltGraph } from '@/core/graph/graph-builder';
import type { LMEQuestion, LMESession } from './dataset';

// LongMemEval uses dates like "2023/03/31 (Fri) 14:13". The day-of-week is
// useful for temporal questions ("last Friday") but the time-of-day is noise
// and the slashes don't match the YYYY-MM-DD format the prompt promises.
// Normalize to "2023-03-31 (Fri)" so every node + today's-date preamble
// agrees on format.
export function normalizeDate(raw: string | undefined | null): string {
  if (!raw) return '';
  const slashMatch = raw.match(/^(\d{4})\/(\d{2})\/(\d{2})\s*(?:\(([A-Za-z]{3})\))?/);
  if (slashMatch) {
    const [, y, m, d, dow] = slashMatch;
    return dow ? `${y}-${m}-${d} (${dow})` : `${y}-${m}-${d}`;
  }
  // Fall back to Date.parse for ISO-ish inputs; keep the raw string on failure.
  const ms = Date.parse(raw);
  if (Number.isFinite(ms)) {
    const d = new Date(ms);
    const iso = d.toISOString().slice(0, 10);
    const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
    return `${iso} (${dow})`;
  }
  return raw;
}

function sessionToDocument(
  questionId: string,
  sessionId: string,
  sessionDateStr: string,
  turns: LMESession
): ParsedDocument {
  const startedAt = Date.parse(sessionDateStr);
  const startedAtMs = Number.isFinite(startedAt) ? startedAt : Date.now();
  const normalized = normalizeDate(sessionDateStr);

  const conv: ParsedConversation = {
    id: `${questionId}/${sessionId}`,
    title: sessionId,
    messages: turns.map(t => ({ role: t.role, content: t.content })),
    sourceFile: `lme:${questionId}:${sessionId}`,
    startedAt: startedAtMs,
    format: 'raw',
    metadata: {
      messageCount: turns.length,
      sessionId,
      sessionDate: normalized,
    },
  };

  const doc = conversationToDocument(conv);
  // Preserve session timing + ids on the ParsedDocument so downstream temporal
  // reasoning has something to latch onto.
  doc.metadata = {
    ...doc.metadata,
    sessionId,
    sessionDate: normalized,
    startedAt: startedAtMs,
  };
  return doc;
}

export function buildSessionDocsForQuestion(q: LMEQuestion): ParsedDocument[] {
  const docs: ParsedDocument[] = [];
  for (let i = 0; i < q.haystack_sessions.length; i++) {
    const sessionId = q.haystack_session_ids[i] ?? `session_${i}`;
    const sessionDate = q.haystack_dates[i] ?? q.question_date;
    docs.push(sessionToDocument(q.question_id, sessionId, sessionDate, q.haystack_sessions[i]));
  }
  return docs;
}

export function buildGraphForQuestion(q: LMEQuestion): BuiltGraph {
  return buildGraph(buildSessionDocsForQuestion(q), `lme:${q.question_id}`);
}
