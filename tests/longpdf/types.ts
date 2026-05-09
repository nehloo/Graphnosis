// Shared types for the long-PDF benchmark.

export type DocId = 'filing.pdf' | 'manual.pdf' | 'paper.pdf';

export type Tier = 1 | 2 | 3;

export interface Question {
  id: string;            // e.g. "filing-T1-01"
  doc: DocId;
  tier: Tier;
  question: string;
  // Heading anchors or page-range strings that the answer should cite.
  // Examples: "Item 1A. Risk Factors", "MD&A — Liquidity", "§3.2", "pp. 45-47".
  gold_sections: string[];
  gold_answer: string;   // Empty string in the skeleton; required for real runs.
  notes?: string;        // Free-form note to the human filling the skeleton.
}

export interface RetrievalCandidate {
  // The candidate's anchor in the document. For HippoCortex this is the node
  // content (truncated) and any sourceFile / page metadata it carries; for
  // embedding RAG it's the chunk text plus its derived section heading.
  text: string;
  // A best-effort section/page label so retrieval@k can be scored against
  // gold_sections without ambiguity. Free-form string; matched by lowercased
  // substring containment in score.ts.
  sectionLabel?: string;
  score: number;
}

export interface BaselineRun {
  baseline: 'hippocortex' | 'embedding-rag';
  questionId: string;
  candidates: RetrievalCandidate[]; // top-k, k = 20
  answer: string;
  latencyMs: number;
  // Free-form metadata captured for telemetry. Not part of scoring.
  meta?: Record<string, unknown>;
}

export type Verdict = 'correct' | 'partial' | 'wrong';

export interface JudgeOutput {
  verdict: Verdict;
  reason: string;
  raw: string;
  judgeModel: string;
}

export interface ScoredQuestion {
  questionId: string;
  doc: DocId;
  tier: Tier;
  retrievalAtK: boolean; // any candidate matched any gold_section
  judge: JudgeOutput;
}

export interface RunSummary {
  baseline: 'hippocortex' | 'embedding-rag';
  k: number;
  total: number;
  retrievalAtK: number;     // count of true
  correct: number;
  partial: number;
  wrong: number;
  byDoc: Record<DocId, { total: number; retrievalAtK: number; correct: number; partial: number; wrong: number }>;
  byTier: Record<Tier, { total: number; retrievalAtK: number; correct: number; partial: number; wrong: number }>;
}
