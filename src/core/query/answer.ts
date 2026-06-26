import { generateText } from 'ai';
import { openai, createOpenAI } from '@ai-sdk/openai';
import type { KnowledgeGraph, ParsedDocument, SubgraphContext, TfidfIndex, NodeId } from '@/core/types';
import { queryGraph, buildGraphPrompt } from './query-engine';
import type { RouterDecision } from './router';
import { embedQuery, type EmbeddingIndex } from '@/core/similarity/embeddings';
import type { EmbeddingAdapter } from '@/core/similarity/embedding-adapter';
import { openaiEmbedAdapter } from '@/sdk/adapters/openai';
import {
  extractPreferences,
  renderPreferenceBlock,
  type PreferenceStatement,
} from '@/core/enrichment/preference-extractor';
import type { LMEQuestionType } from '@/core/types';

// Non-streaming question-answering helper.
// Shared by the /api/graph/query route and the LongMemEval official runner
// so both paths use the exact same retrieval + prompt + model.

export type RetrievalMode = 'tfidf' | 'embeddings' | 'hybrid' | 'naive-topk' | 'full-context';

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
  /**
   * Optional. If provided, used to embed the query. Otherwise an
   * OpenAI adapter is constructed from `embeddingModel`. Lets callers
   * (LongMemEval runner, future Voyage path) supply a non-OpenAI source.
   */
  embeddingAdapter?: EmbeddingAdapter;
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
  // Local-LLM answer path (offline eval). When `answerBaseURL` is set, the
  // answer model is constructed against an OpenAI-compatible endpoint
  // (e.g. Ollama at http://localhost:11434/v1) instead of the OpenAI cloud.
  // The default path (unset) is byte-identical to prior behavior, so the
  // chat API route is unaffected.
  answerBaseURL?: string;
  answerApiKey?: string; // defaults to 'ollama' when answerBaseURL is set
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

  // Baseline ablation modes (no graph), for isolating the contribution of
  // graph-structured retrieval with the answer model held fixed (§12.4):
  //   'naive-topk'   - top-k chunks by raw TF-IDF similarity; no traversal,
  //                    no typed edges, no temporal scoring.
  //   'full-context' - all chunks, no retrieval at all.
  // Both return before the embedding/graph path below.
  if (retrieval === 'naive-topk' || retrieval === 'full-context') {
    const maxChars = retrieval === 'full-context' ? 120_000 : 40_000;
    // naive-topk draws the IDENTICAL seed pool the graph arm traverses from
    // (same query decomposition, synonym expansion, and seed budget) but
    // applies no traversal, typed edges, or temporal scoring — so the only
    // difference from the graph arm is the graph structure itself (§12.4).
    const ordered =
      retrieval === 'full-context'
        ? [...graph.nodes.values()].map((n) => n.content)
        : queryGraph(graph, tfidfIndex, question, {
            maxNodes: opts.maxNodes,
            useRouter: opts.useRouter,
            questionType: opts.questionType,
            seedsOnly: true,
          }).seeds
            .map((s) => graph.nodes.get(s.nodeId)?.content ?? '')
            .filter(Boolean);
    const picked: string[] = [];
    let acc = 0;
    for (const c of ordered) {
      if (acc + c.length > maxChars) break;
      picked.push(c);
      acc += c.length;
    }
    const serialized =
      `=== RETRIEVED EVIDENCE (${picked.length} chunks, ${retrieval}, no graph) ===\n` +
      picked.map((c, i) => `[${i + 1}] ${c}`).join('\n');
    const systemPrompt = buildGraphPrompt(serialized, question, {
      questionDate: opts.questionDate,
      questionType: opts.questionType,
    });
    const provider = opts.answerBaseURL
      ? createOpenAI({ baseURL: opts.answerBaseURL, apiKey: opts.answerApiKey ?? 'ollama' })
      : openai;
    const result = await generateText({
      model: provider(opts.model ?? 'gpt-4o-mini'),
      system: systemPrompt,
      messages: [...(opts.priorMessages ?? []), { role: 'user' as const, content: question }],
    });
    return {
      answer: result.text,
      subgraph: { nodes: [], directedEdges: [], undirectedEdges: [], serialized },
      seeds: [],
      nodeCount: picked.length,
      systemPrompt,
      retrieval,
      router: undefined,
      preferences: undefined,
    };
  }

  // Embed the query once if we're going to use it. Skipped in tfidf-only mode
  // so we don't pay for an unused API call.
  let queryEmbedding: number[] | null = null;
  if (retrieval !== 'tfidf') {
    if (!opts.embeddingIndex) {
      throw new Error(
        `answerQuestion: retrieval=${retrieval} requires embeddingIndex on the graph (call attachEmbeddings first)`
      );
    }
    const adapter = opts.embeddingAdapter ?? openaiEmbedAdapter({ model: opts.embeddingModel });
    queryEmbedding = await embedQuery(adapter, question);
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

  // Default path uses the OpenAI cloud provider. When answerBaseURL is set,
  // route to an OpenAI-compatible local endpoint (Ollama) for a fully
  // offline answer model — no cloud call at inference time.
  const answerProvider = opts.answerBaseURL
    ? createOpenAI({ baseURL: opts.answerBaseURL, apiKey: opts.answerApiKey ?? 'ollama' })
    : openai;

  const result = await generateText({
    model: answerProvider(opts.model ?? 'gpt-4o-mini'),
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
