import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';
import type { KnowledgeGraph, SubgraphContext, TfidfIndex, NodeId } from '@/core/types';
import { queryGraph, buildGraphPrompt } from './query-engine';

// Non-streaming question-answering helper.
// Shared by the /api/graph/query route and the LongMemEval official runner
// so both paths use the exact same retrieval + prompt + model.

export interface AnswerOptions {
  model?: string; // OpenAI model id; defaults to gpt-4o-mini (same as chat route)
  priorMessages?: Array<{ role: 'user' | 'assistant'; content: string }>;
  questionDate?: string; // ISO date treated as "today" for the prompt
  maxNodes?: number; // Override subgraph size cap (default: TOP_K_NODES = 20)
}

export interface AnswerResult {
  answer: string;
  subgraph: SubgraphContext;
  seeds: Array<{ nodeId: NodeId; score: number }>;
  nodeCount: number;
  systemPrompt: string;
}

export async function answerQuestion(
  graph: KnowledgeGraph,
  tfidfIndex: TfidfIndex,
  question: string,
  opts: AnswerOptions = {}
): Promise<AnswerResult> {
  const { subgraph, seeds } = queryGraph(graph, tfidfIndex, question, {
    maxNodes: opts.maxNodes,
    questionDate: opts.questionDate,
  });
  const systemPrompt = buildGraphPrompt(subgraph.serialized, question, {
    questionDate: opts.questionDate,
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
  };
}
