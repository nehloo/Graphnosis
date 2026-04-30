// Phase 2: per-session compressed summary for LongMemEval multi-session
// aggregation. A full haystack has ~50 sessions × ~50 turns ≈ 2500 turn
// nodes — retrieval at 20-50 nodes can't cover all of them. A summary
// node per session gives multi-session + temporal-reasoning questions a
// dense, seed-able index of "what happened in this session" without
// displacing turn-level evidence for targeted single-session questions.
//
// Used by enrichSessionGraph (ingest time), cached on content hash so
// repeated 500q runs don't re-pay for the same session.
//
// Cost model: ~$0.0005 per session × ~25k LongMemEval_s sessions = ~$12
// on a cold run; cache hits bring subsequent runs to near-zero.

import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { nanoid } from 'nanoid';
import type {
  ConversationMessage,
  DirectedEdge,
  GraphNode,
  ParsedDocument,
  NodeId,
} from '@/core/types';
import type { BuiltGraph } from '@/core/graph/graph-builder';
import { addDocument, computeIdf } from '@/core/similarity/tfidf';
import { readCache, writeCache, hashContent } from './enrichment-cache';

export interface SessionSummary {
  summary: string; // Dense ~200-token paragraph covering what happened
  entities: string[]; // Canonical names mentioned in this session
  dates: string[]; // Any dates/times referenced (YYYY-MM-DD when possible)
  claims: string[]; // Short, atomic user/assistant claims worth indexing
}

function buildSummaryPrompt(
  sessionDate: string,
  turns: ConversationMessage[]
): string {
  const transcript = turns
    .map((t, i) => `[${i + 1}] ${t.role}: ${t.content}`)
    .join('\n');

  return `You are compressing a chat session into a searchable index entry. The session happened on ${sessionDate || 'an unknown date'}.

IMPORTANT: The transcript may be in ANY language (English, Romanian, French, German, Spanish, Chinese, Japanese, Arabic, Russian, etc.). You MUST:
- Write the summary in the SAME language as the transcript
- Preserve entities in their original script (don't transliterate: keep "東京" not "Tokyo" if the transcript is in Japanese, keep "Müller" not "Mueller", keep "București" not "Bucharest")
- Extract claims in the speaker's original language and voice

TRANSCRIPT:
${transcript}

Respond with ONLY valid JSON, no markdown:
{
  "summary": "A single dense paragraph (~200 tokens) describing what the user stated, what they asked, and what the assistant said or recommended. Preserve concrete facts, numbers, names, dates. Omit filler. Write in the transcript's language.",
  "entities": ["canonical names mentioned (people, places, orgs, products) — in original script, lowercase where applicable, deduped"],
  "dates": ["any dates or times referenced in the turns — prefer YYYY-MM-DD"],
  "claims": ["short atomic statements worth indexing separately, in the speaker's voice and language, e.g. 'I bought 30 lbs of coffee beans' or 'Prefer hotel-uri cu vedere la mare'"]
}

Rules:
- Preserve user voice in claims — "I prefer X" not "User prefers X".
- Claims should each be self-contained; omit vague ones.
- Keep entities in their original script and language — do not transliterate or translate proper nouns.
- If the session has no substantive content, return empty arrays and a one-sentence summary.`;
}

function parseResponse(raw: string): SessionSummary | null {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    if (typeof parsed.summary !== 'string') return null;
    return {
      summary: parsed.summary,
      entities: Array.isArray(parsed.entities) ? parsed.entities.filter((e: unknown) => typeof e === 'string') : [],
      dates: Array.isArray(parsed.dates) ? parsed.dates.filter((e: unknown) => typeof e === 'string') : [],
      claims: Array.isArray(parsed.claims) ? parsed.claims.filter((e: unknown) => typeof e === 'string') : [],
    };
  } catch {
    return null;
  }
}

export interface SummarizeSessionOptions {
  model?: string; // defaults to gpt-4o-mini
  sessionDate?: string;
  useCache?: boolean; // defaults to true
}

export async function summarizeSession(
  turns: ConversationMessage[],
  opts: SummarizeSessionOptions = {}
): Promise<SessionSummary | null> {
  if (turns.length === 0) return null;

  const useCache = opts.useCache !== false;
  const sessionDate = opts.sessionDate ?? '';
  // Cache key includes the date so two identical transcripts on different
  // days (unusual, but possible in synthetic haystacks) don't collide.
  const hash = hashContent(
    sessionDate + '|' + turns.map(t => `${t.role}:${t.content}`).join('\n')
  );

  if (useCache) {
    const cached = await readCache<SessionSummary>('session-summary', hash);
    if (cached) return cached;
  }

  const prompt = buildSummaryPrompt(sessionDate, turns);
  const result = await generateText({
    model: openai(opts.model ?? 'gpt-4o-mini'),
    prompt,
  });
  const parsed = parseResponse(result.text);
  if (!parsed) return null;

  if (useCache) {
    await writeCache('session-summary', hash, parsed);
  }
  return parsed;
}

// ----------------------------------------------------------------------
// Graph-level hook: enrich a freshly-built LongMemEval graph with one
// summary node per session, linked back to each turn via a 'summarizes'
// directed edge. Called between buildGraphForQuestion and attachEmbeddings.
//
// - Skipped when --enable-session-summaries is off.
// - Cache is shared across questions + runs (sessions overlap heavily).
// - Summary nodes are added to the TF-IDF index so seed-finder can
//   retrieve them lexically; embeddings (if enabled) are handled by
//   attachEmbeddings running after this pass.
// ----------------------------------------------------------------------

export interface EnrichSessionGraphOptions {
  model?: string;
  useCache?: boolean;
  concurrency?: number; // Parallel summary calls — OpenAI quota permitting
  // When set, skip sessions whose document has no turn nodes in the graph
  // (e.g., pruned / below minimum chunk length). Defaults to true.
  skipEmpty?: boolean;
  // Optional progress callback — invoked after each session completes so
  // the CLI can print a live "summarized X/Y" line instead of a 20s gap.
  onProgress?: (done: number, total: number, cacheHits: number) => void;
}

export interface EnrichSessionGraphResult {
  summaryCount: number;
  edgeCount: number;
  cacheHits: number;
  llmCalls: number;
  failures: number;
}

export async function enrichSessionGraph(
  graph: BuiltGraph,
  docs: ParsedDocument[],
  opts: EnrichSessionGraphOptions = {}
): Promise<EnrichSessionGraphResult> {
  const concurrency = Math.max(1, opts.concurrency ?? 6);
  const skipEmpty = opts.skipEmpty !== false;

  // Group existing turn nodes by session so we can wire 'summarizes' edges.
  // Turn nodes carry source.file = `conversation:{questionId}/{sessionId}`.
  const turnsBySession = new Map<string, NodeId[]>();
  for (const [nodeId, node] of graph.nodes) {
    const f = node.source?.file;
    if (!f || !f.startsWith('conversation:')) continue;
    const list = turnsBySession.get(f) ?? [];
    list.push(nodeId);
    turnsBySession.set(f, list);
  }

  // Prepare (doc, turns) work items.
  interface WorkItem {
    doc: ParsedDocument;
    sessionSourceFile: string;
    turnNodes: NodeId[];
    messages: ConversationMessage[];
    sessionDate: string;
    sessionId: string;
  }
  const items: WorkItem[] = [];
  for (const doc of docs) {
    // The doc's sourceFile is something like `conversation:{qid}/{sid}`.
    const sessionSourceFile = doc.sourceFile;
    const turnNodes = turnsBySession.get(sessionSourceFile) ?? [];
    if (skipEmpty && turnNodes.length === 0) continue;

    // Reconstruct the turn messages from the doc sections (already role-tagged
    // by conversationToDocument). System messages were filtered out at that
    // step, so sections match user/assistant turns in order.
    const messages: ConversationMessage[] = doc.sections.map(s => {
      const role = s.title.startsWith('User') ? 'user' : 'assistant';
      return { role: role as 'user' | 'assistant', content: s.content };
    });

    items.push({
      doc,
      sessionSourceFile,
      turnNodes,
      messages,
      sessionDate: String(doc.metadata.sessionDate ?? ''),
      sessionId: String(doc.metadata.sessionId ?? ''),
    });
  }

  let cacheHits = 0;
  let llmCalls = 0;
  let failures = 0;
  let summaryCount = 0;
  let edgeCount = 0;
  let done = 0;
  const total = items.length;

  // True lane pool: each lane pulls the next item as soon as it's free, so
  // one slow gpt-4o-mini call doesn't stall a whole batch of 6.
  let cursor = 0;
  async function lane(): Promise<void> {
    while (cursor < items.length) {
      const myIdx = cursor++;
      const item = items[myIdx];

      const hash = hashContent(
        item.sessionDate +
          '|' +
          item.messages.map(t => `${t.role}:${t.content}`).join('\n')
      );
      const cached = opts.useCache !== false
        ? await readCache<SessionSummary>('session-summary', hash)
        : null;

      let summary: SessionSummary | null = null;
      let fromCache = false;
      if (cached) {
        summary = cached;
        fromCache = true;
      } else {
        try {
          summary = await summarizeSession(item.messages, {
            model: opts.model,
            sessionDate: item.sessionDate,
            useCache: opts.useCache,
          });
        } catch {
          summary = null;
        }
      }

      done++;
      if (fromCache) cacheHits++;
      else if (summary) llmCalls++;
      if (!summary) {
        failures++;
        if (opts.onProgress) opts.onProgress(done, total, cacheHits);
        continue;
      }

      const now = Date.now();
      const content = summary.summary;
      const startedAt = Number(item.doc.metadata.startedAt) || now;

      const summaryNode: GraphNode = {
        id: nanoid(),
        content,
        contentHash: hashContent(content),
        type: 'session-summary',
        source: {
          file: item.sessionSourceFile,
          offset: 0,
          section: 'session-summary',
        },
        entities: summary.entities.slice(0, 20),
        metadata: {
          sessionId: item.sessionId,
          sessionDate: item.sessionDate,
          startedAt,
          turnCount: item.turnNodes.length,
          claimCount: summary.claims.length,
          // Store claims as a delimited string so the metadata type stays
          // Record<string, string | number> — serializer can split on `||`.
          claims: summary.claims.join(' || '),
          dates: summary.dates.join(' || '),
        },
        level: 1, // Summary level — above raw turn nodes at level 0
        confidence: 0.8,
        createdAt: now,
        lastAccessedAt: now,
        accessCount: 0,
      };

      graph.nodes.set(summaryNode.id, summaryNode);
      summaryCount++;

      // Wire summary → each turn with 'summarizes'. Weight 0.7 > the
      // pruner's minDirectedWeight so these edges survive optimization.
      for (const turnId of item.turnNodes) {
        const edge: DirectedEdge = {
          id: nanoid(),
          from: summaryNode.id,
          to: turnId,
          type: 'summarizes',
          weight: 0.7,
          createdAt: now,
        };
        graph.directedEdges.set(edge.id, edge);
        edgeCount++;
      }

      // Index the summary text so TF-IDF can retrieve it as a seed.
      addDocument(graph.tfidfIndex, summaryNode.id, content);

      if (opts.onProgress) opts.onProgress(done, total, cacheHits);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => lane())
  );

  // Recompute IDF once after all summaries are indexed — cheaper than once
  // per doc, and only needed for the summary docs we added.
  if (summaryCount > 0) {
    computeIdf(graph.tfidfIndex);
    graph.metadata.nodeCount = graph.nodes.size;
    graph.metadata.directedEdgeCount = graph.directedEdges.size;
    graph.metadata.updatedAt = Date.now();
  }

  return { summaryCount, edgeCount, cacheHits, llmCalls, failures };
}
