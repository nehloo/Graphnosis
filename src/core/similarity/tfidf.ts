import type { TfidfIndex, NodeId, IndexProvenance } from '@/core/types';
import { asciiFoldAnalyzer, type TextAnalyzer } from './analyzer';

/**
 * Internal: the TF-IDF index needs to remember its analyzer at runtime so
 * `queryVector` and `addDocument` can both tokenize consistently. The
 * persisted `provenance.adapterId` field handles cross-process identity;
 * this map handles in-process behavior.
 */
const analyzerByIndex = new WeakMap<TfidfIndex, TextAnalyzer>();

function analyzerFor(index: TfidfIndex): TextAnalyzer {
  return analyzerByIndex.get(index) ?? asciiFoldAnalyzer;
}

export function createTfidfIndex(analyzer: TextAnalyzer = asciiFoldAnalyzer): TfidfIndex {
  const provenance: IndexProvenance = {
    adapterId: analyzer.id,
    createdAt: Date.now(),
  };
  const index: TfidfIndex = {
    documents: new Map(),
    idf: new Map(),
    documentCount: 0,
    provenance,
  };
  analyzerByIndex.set(index, analyzer);
  return index;
}

/**
 * Re-attach an analyzer to an index loaded from .gai / SQLite. Called by
 * the SDK on `loadGai` / `loadSqlite*` after `AnalyzerMismatchError`
 * checks pass.
 */
export function attachAnalyzer(index: TfidfIndex, analyzer: TextAnalyzer): void {
  analyzerByIndex.set(index, analyzer);
}

/**
 * Lower-case + tokenize using the analyzer attached to `index`. Falls
 * back to `asciiFoldAnalyzer` if no analyzer was attached (defensive —
 * the SDK always attaches one via `createTfidfIndex`).
 */
function tokenize(index: TfidfIndex, text: string): string[] {
  const a = analyzerFor(index);
  const tokens = a.tokenize(text);
  if (!a.stopwords) return tokens;
  return tokens.filter(t => !a.stopwords!.has(t));
}

/**
 * Standalone tokenizer using the default English analyzer. Kept for
 * backwards compatibility with callers that pre-date the analyzer
 * refactor (notably `undirected-edges.ts`, which still uses this for
 * entity overlap). New callers should go through the index-bound path.
 */
export function tokenizeWith(analyzer: TextAnalyzer, text: string): string[] {
  const tokens = analyzer.tokenize(text);
  if (!analyzer.stopwords) return tokens;
  return tokens.filter(t => !analyzer.stopwords!.has(t));
}

export function addDocument(index: TfidfIndex, nodeId: NodeId, text: string): void {
  const tokens = tokenize(index, text);
  const tf = new Map<string, number>();

  // Compute term frequency
  for (const token of tokens) {
    tf.set(token, (tf.get(token) || 0) + 1);
  }

  // Normalize TF by document length
  const maxFreq = Math.max(...tf.values(), 1);
  const normalizedTf = new Map<string, number>();
  for (const [term, freq] of tf) {
    normalizedTf.set(term, freq / maxFreq);
  }

  index.documents.set(nodeId, normalizedTf);
  index.documentCount++;
}

export function computeIdf(index: TfidfIndex): void {
  const termDocCount = new Map<string, number>();

  // Count how many documents each term appears in
  for (const tfMap of index.documents.values()) {
    for (const term of tfMap.keys()) {
      termDocCount.set(term, (termDocCount.get(term) || 0) + 1);
    }
  }

  // Compute IDF: log(N / df) with smoothing
  for (const [term, df] of termDocCount) {
    index.idf.set(term, Math.log((index.documentCount + 1) / (df + 1)) + 1);
  }
}

export function getTfidfVector(index: TfidfIndex, nodeId: NodeId): Map<string, number> {
  const tf = index.documents.get(nodeId);
  if (!tf) return new Map();

  const tfidf = new Map<string, number>();
  for (const [term, tfVal] of tf) {
    const idfVal = index.idf.get(term) || 0;
    tfidf.set(term, tfVal * idfVal);
  }
  return tfidf;
}

export function queryVector(index: TfidfIndex, text: string): Map<string, number> {
  const tokens = tokenize(index, text);
  const tf = new Map<string, number>();

  for (const token of tokens) {
    tf.set(token, (tf.get(token) || 0) + 1);
  }

  const maxFreq = Math.max(...tf.values(), 1);
  const tfidf = new Map<string, number>();

  for (const [term, freq] of tf) {
    const idfVal = index.idf.get(term) || 0;
    tfidf.set(term, (freq / maxFreq) * idfVal);
  }

  return tfidf;
}
