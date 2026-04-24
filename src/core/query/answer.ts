import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';
import type { KnowledgeGraph, ParsedDocument, SubgraphContext, TfidfIndex, NodeId } from '@/core/types';
import { queryGraph, buildGraphPrompt } from './query-engine';
import type { RouterDecision } from './router';
import { embedQuery, type EmbeddingIndex } from '@/core/similarity/embeddings';
import {
  extractPreferences,
  renderPreferenceBlock,
  type PreferenceStatement,
} from '@/core/enrichment/preference-extractor';
import type { LMEQuestionType } from '@/core/types';

// Non-streaming question-answering helper.
// Shared by the /api/graph/query route and the LongMemEval official runner
// so both paths use the exact same retrieval + prompt + model.

export type RetrievalMode = 'tfidf' | 'embeddings' | 'hybrid';

export interface AnswerOptions {
  model?: string; // OpenAI model id; defaults to gpt-4o-mini (same as chat route)
  priorMessages?: Array<{ role: 'user' | 'assistant'; content: string }>;
  questionDate?: string; // ISO date treated as "today" for the prompt
  maxNodes?: number; // Override subgraph size cap (default: TOP_K_NODES = 20)
  // Retrieval mode:
  //   'tfidf'      - lexical term overlap only (default; no API calls for retrieval)
  //   'embeddings' - semantic only (requires embeddingIndex on the graph)
  //   'hybrid'     - merge TF-IDF and embedding seeds
  retrieval?: RetrievalMode;
  embeddingIndex?: EmbeddingIndex; // required when retrieval !== 'tfidf'
  embeddingModel?: string; // for embedding the query (default text-embedding-3-small)
  // Phase 1 router integration. When `useRouter` is true, the query engine
  // classifies the question at runtime and uses the router-provided
  // strategy + prompt variant. When `questionType` is explicitly set, it
  // skips classification (used for ground-truth ablations; off by default
  // to keep the leaderboard number honest).
  useRouter?: boolean;
  questionType?: LMEQuestionType;
  // Phase 3 — query-time preference extraction. When enabled AND the router
  // classifies the question as single-session-preference, we fan out an
  // LLM pass per session to distill user-voice preference statements and
  // inject them into the answer prompt ahead of the turn evidence.
  // Requires `documents` so the extractor has the session transcripts.
  enablePreferenceExtraction?: boolean;
  documents?: ParsedDocument[];
  preferenceModel?: string; // defaults to gpt-4o-mini
  preferenceConcurrency?: number; // lane pool size (default 6)
}

export interface AnswerResult {
  answer: string;
  subgraph: SubgraphContext;
  seeds: Array<{ nodeId: NodeId; score: number }>;
  nodeCount: number;
  systemPrompt: string;
  retrieval: RetrievalMode;
  // Present whenever the router ran (either via useRouter or explicit
  // questionType). Surfaced here so the test harness can emit per-question
  // telemetry without re-deriving the decision.
  router?: RouterDecision;
  // Phase 3 telemetry: populated when preference extraction ran.
  preferences?: {
    statements: PreferenceStatement[];
    cacheHits: number;
    llmCalls: number;
    failures: number;
  };
}

export async function answerQuestion(
  graph: KnowledgeGraph,
  tfidfIndex: TfidfIndex,
  question: string,
  opts: AnswerOptions = {}
): Promise<AnswerResult> {
  const retrieval: RetrievalMode = opts.retrieval ?? 'tfidf';

  // Embed the query once if we're going to use it. Skipped in tfidf-only mode
  // so we don't pay for an unused API call.
  let queryEmbedding: number[] | null = null;
  if (retrieval !== 'tfidf') {
    if (!opts.embeddingIndex) {
      throw new Error(
        `answerQuestion: retrieval=${retrieval} requires embeddingIndex on the graph (call attachEmbeddings first)`
      );
    }
    queryEmbedding = await embedQuery(question, { model: opts.embeddingModel });
  }

  const { subgraph, seeds, router } = queryGraph(graph, tfidfIndex, question, {
    maxNodes: opts.maxNodes,
    embeddingIndex: retrieval === 'tfidf' ? undefined : opts.embeddingIndex,
    queryEmbedding: queryEmbedding ?? undefined,
    embeddingsOnly: retrieval === 'embeddings',
    useRouter: opts.useRouter,
    questionType: opts.questionType,
  });

  // Phase 3: query-time preference extraction. Runs only when the router
  // has classified this as single-session-preference AND the caller has
  // explicitly enabled it AND documents are provided. Extracted statements
  // are prepended to the serialized subgraph so the answer model sees
  // distilled user-voice evidence ahead of raw turn evidence.
  const effectiveCategory = router?.category ?? opts.questionType;
  let preferencesResult: AnswerResult['preferences'];
  let serializedForPrompt = subgraph.serialized;
  if (
    opts.enablePreferenceExtraction &&
    effectiveCategory === 'single-session-preference' &&
    opts.documents &&
    opts.documents.length > 0
  ) {
    const extraction = await extractPreferences(question, opts.documents, {
      model: opts.preferenceModel,
      concurrency: opts.preferenceConcurrency,
    });
    preferencesResult = {
      statements: extraction.statements,
      cacheHits: extraction.cacheHits,
      llmCalls: extraction.llmCalls,
      failures: extraction.failures,
    };
    const block = renderPreferenceBlock(extraction.statements);
    if (block) serializedForPrompt = block + serializedForPrompt;
  }

  const systemPrompt = buildGraphPrompt(serializedForPrompt, question, {
    questionDate: opts.questionDate,
    // When the router ran, pass its (possibly-inferred) category to the
    // prompt builder so it picks the right category-specific block.
    questionType: effectiveCategory,
  });

  const messages = [
    ...(opts.priorMessages ?? []),
    { role: 'user' as const, content: question },
  ];

  const result = await generateText({
    model: openai(opts.model ?? 'gpt-4o-mini'),
    system: systemPrompt,
    messages,
  });

  return {
    answer: result.text,
    subgraph,
    seeds,
    nodeCount: subgraph.nodes.length,
    systemPrompt,
    retrieval,
    router,
    preferences: preferencesResult,
  };
}
