// B1 — HippoCortex as-is. Calls answerQuestion() in-process so we benchmark
// the same retrieval + prompt + model the served /api/graph/query route uses.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildGraph } from '@/core/graph/graph-builder';
import { parseMarkdown } from '@/core/ingestion/parsers/markdown-parser';
import { parsePdf } from '@/core/ingestion/parsers/pdf-parser';
import { answerQuestion } from '@/core/query/answer';
import type { ParsedDocument, KnowledgeGraph, TfidfIndex } from '@/core/types';
import type { Question, BaselineRun, RetrievalCandidate, DocId } from '../types';

// Resolved from process.cwd() — harness must be run from the repo root.
const CORPUS_DIR = resolve('tests/longpdf/corpus');
const TOP_K = 20;

interface IngestedDoc {
  doc: DocId;
  graph: KnowledgeGraph & { tfidfIndex: TfidfIndex };
}

const cache = new Map<DocId, IngestedDoc>();

export async function ingest(doc: DocId): Promise<IngestedDoc> {
  const cached = cache.get(doc);
  if (cached) return cached;

  const path = `${CORPUS_DIR}/${doc}`;
  const documents: ParsedDocument[] = [];

  if (doc.endsWith('.pdf')) {
    const buf = readFileSync(path);
    documents.push(await parsePdf(buf, doc));
  } else if (doc.endsWith('.md')) {
    const text = readFileSync(path, 'utf8');
    documents.push(parseMarkdown(text, doc));
  } else {
    throw new Error(`hippocortex baseline: unsupported extension for ${doc}`);
  }

  const built = buildGraph(documents, `longpdf:${doc}`);
  if (!built.tfidfIndex) {
    throw new Error(`hippocortex baseline: buildGraph did not produce a tfidfIndex for ${doc}`);
  }
  const ingested: IngestedDoc = { doc, graph: built as KnowledgeGraph & { tfidfIndex: TfidfIndex } };
  cache.set(doc, ingested);
  return ingested;
}

export async function run(q: Question, opts: { dryRun?: boolean } = {}): Promise<BaselineRun> {
  const t0 = Date.now();
  const { graph } = await ingest(q.doc);

  // In dry-run mode, only collect retrieval candidates — skip answer synthesis.
  // We accomplish this by passing maxNodes through and ignoring the returned
  // answer string. answerQuestion always issues an LLM call; for dry-run we
  // route through queryGraph directly.
  if (opts.dryRun) {
    const { queryGraph } = await import('@/core/query/query-engine');
    const { subgraph, seeds } = queryGraph(graph, graph.tfidfIndex, q.question);
    return {
      baseline: 'hippocortex',
      questionId: q.id,
      candidates: subgraphToCandidates(subgraph, seeds),
      answer: '', // not synthesized in dry-run
      latencyMs: Date.now() - t0,
      meta: { dryRun: true, nodeCount: subgraph.nodes.length },
    };
  }

  const result = await answerQuestion(graph, graph.tfidfIndex, q.question, {
    maxNodes: TOP_K,
  });

  return {
    baseline: 'hippocortex',
    questionId: q.id,
    candidates: subgraphToCandidates(result.subgraph, result.seeds),
    answer: result.answer,
    latencyMs: Date.now() - t0,
    meta: {
      retrieval: result.retrieval,
      nodeCount: result.nodeCount,
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function subgraphToCandidates(subgraph: any, seeds: any): RetrievalCandidate[] {
  const seedScore = new Map<string, number>();
  for (const s of seeds) seedScore.set(s.nodeId, s.score);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (subgraph.nodes as any[]).slice(0, TOP_K).map(n => {
    // Heuristic section label: prefer an explicit `section` field if the
    // node carries one, else fall back to `sourceFile` / first heading
    // line in the content. Score.ts only does substring matching.
    const sectionLabel =
      (n.metadata && (n.metadata.section || n.metadata.heading)) ||
      n.sourceFile ||
      firstLine(n.content);
    return {
      text: typeof n.content === 'string' ? n.content.slice(0, 400) : '',
      sectionLabel,
      score: seedScore.get(n.id) ?? 0,
    };
  });
}

function firstLine(s: unknown): string | undefined {
  if (typeof s !== 'string') return undefined;
  const line = s.split('\n').find(l => l.trim());
  return line ? line.slice(0, 120) : undefined;
}
