// B2 — vanilla embedding RAG. Deliberately simple: chunk on paragraphs +
// hard cap at ~500 tokens with 50-token overlap, OpenAI embeddings, cosine
// top-k, single-shot answer synthesis with the same model the chat route
// uses. Honest baseline. ~200 lines on purpose.

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { embed, embedMany, generateText } from 'ai';
import { openai } from '@ai-sdk/openai';
import type { ParsedDocument, ParsedSection } from '@/core/types';
import type { Question, BaselineRun, RetrievalCandidate, DocId } from '../types';

// Resolved from process.cwd() — harness must be run from the repo root.
const CORPUS_DIR = resolve('tests/longpdf/corpus');
const TOP_K = 20;
const CHUNK_TOKENS = 500;
const OVERLAP_TOKENS = 50;
const EMBED_MODEL = 'text-embedding-3-small';
const ANSWER_MODEL = 'gpt-4o-mini'; // matches /api/graph/query for fairness

interface Chunk {
  text: string;
  sectionLabel?: string;
  embedding: number[];
}

const cache = new Map<DocId, Chunk[]>();

export async function ingest(doc: DocId): Promise<Chunk[]> {
  const cached = cache.get(doc);
  if (cached) return cached;

  const path = join(CORPUS_DIR, doc);
  let raw: string;

  if (doc.endsWith('.md')) {
    raw = readFileSync(path, 'utf8');
  } else if (doc.endsWith('.pdf')) {
    // Reuse HippoCortex's PDF parser so the chunk text is the same surface
    // both baselines see — this isolates retrieval as the variable.
    const { parsePdf } = await import('@/core/ingestion/parsers/pdf-parser');
    const parsed = await parsePdf(readFileSync(path), doc);
    raw = flattenSections(parsed);
  } else {
    throw new Error(`embedding-rag: unsupported extension for ${doc}`);
  }

  const sliced = chunkText(raw, CHUNK_TOKENS, OVERLAP_TOKENS);
  const texts = sliced.map(s => s.text);

  // Batch embed. ai SDK's embedMany handles batching internally for OpenAI.
  const { embeddings } = await embedMany({
    model: openai.embedding(EMBED_MODEL),
    values: texts,
  });

  const chunks: Chunk[] = sliced.map((s, i) => ({
    text: s.text,
    sectionLabel: s.sectionLabel,
    embedding: embeddings[i],
  }));

  cache.set(doc, chunks);
  return chunks;
}

export async function run(q: Question, opts: { dryRun?: boolean } = {}): Promise<BaselineRun> {
  const t0 = Date.now();
  const chunks = await ingest(q.doc);

  // Embed query.
  const { embedding: queryVec } = await embed({
    model: openai.embedding(EMBED_MODEL),
    value: q.question,
  });

  // Cosine top-k.
  const scored = chunks
    .map(c => ({ chunk: c, score: cosine(queryVec, c.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_K);

  const candidates: RetrievalCandidate[] = scored.map(s => ({
    text: s.chunk.text.slice(0, 400),
    sectionLabel: s.chunk.sectionLabel,
    score: s.score,
  }));

  if (opts.dryRun) {
    return {
      baseline: 'embedding-rag',
      questionId: q.id,
      candidates,
      answer: '',
      latencyMs: Date.now() - t0,
      meta: { dryRun: true, chunkCount: chunks.length },
    };
  }

  // Answer synthesis. Same prompt shape as the chat route's intent.
  const context = scored.map((s, i) => `[${i + 1}] ${s.chunk.sectionLabel ? `(${s.chunk.sectionLabel}) ` : ''}${s.chunk.text}`).join('\n\n');
  const system =
    'You are a careful question-answering system over a single source document. ' +
    'Use ONLY the numbered snippets below. If the answer is not present, say so. ' +
    'Do not invent details.\n\n' +
    `Context:\n${context}`;

  const result = await generateText({
    model: openai(ANSWER_MODEL),
    system,
    messages: [{ role: 'user', content: q.question }],
    temperature: 0,
  });

  return {
    baseline: 'embedding-rag',
    questionId: q.id,
    candidates,
    answer: result.text.trim(),
    latencyMs: Date.now() - t0,
    meta: { chunkCount: chunks.length, answerModel: ANSWER_MODEL, embedModel: EMBED_MODEL },
  };
}

// --- helpers ---

interface SlicedChunk { text: string; sectionLabel?: string }

// Token-approximate chunker. We don't tiktoken here — 1 token ≈ 4 chars is
// good enough for a baseline whose only job is to be reasonable, not optimal.
function chunkText(raw: string, maxTokens: number, overlap: number): SlicedChunk[] {
  const maxChars = maxTokens * 4;
  const overlapChars = overlap * 4;
  const out: SlicedChunk[] = [];

  // Track the most recent heading so each chunk gets a sectionLabel hint.
  // Heuristics: Markdown `#` lines or ALL-CAPS lines that look like headings.
  let currentSection: string | undefined;
  const headingRegex = /^(#{1,6}\s+.+|[A-Z][A-Z0-9 .,'\-—:]{4,80})$/;

  // First pass: split into paragraphs, attaching the running heading.
  const paragraphs: SlicedChunk[] = [];
  for (const block of raw.split(/\n{2,}/)) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    const firstLine = trimmed.split('\n')[0];
    if (headingRegex.test(firstLine)) {
      currentSection = firstLine.replace(/^#+\s*/, '').slice(0, 120);
    }
    paragraphs.push({ text: trimmed, sectionLabel: currentSection });
  }

  // Second pass: pack paragraphs into chunks under the size cap, overlapping
  // the trailing characters between adjacent chunks.
  let buf: SlicedChunk[] = [];
  let bufLen = 0;
  for (const p of paragraphs) {
    if (bufLen + p.text.length > maxChars && buf.length) {
      out.push(flush(buf));
      // Build overlap from the tail of the buffer we're closing.
      const tail = sliceTail(buf, overlapChars);
      buf = tail ? [tail] : [];
      bufLen = tail ? tail.text.length : 0;
    }
    buf.push(p);
    bufLen += p.text.length + 2;
  }
  if (buf.length) out.push(flush(buf));
  return out;
}

function flush(buf: SlicedChunk[]): SlicedChunk {
  return {
    text: buf.map(b => b.text).join('\n\n'),
    sectionLabel: buf[0]?.sectionLabel,
  };
}

function sliceTail(buf: SlicedChunk[], overlapChars: number): SlicedChunk | null {
  if (overlapChars <= 0 || !buf.length) return null;
  const joined = buf.map(b => b.text).join('\n\n');
  const tailText = joined.slice(-overlapChars);
  return { text: tailText, sectionLabel: buf[buf.length - 1]?.sectionLabel };
}

// ParsedDocument has nested sections; flatten depth-first into one string,
// emitting Markdown-style headings so the chunker's heading regex picks them
// up as sectionLabels.
function flattenSections(doc: ParsedDocument): string {
  const out: string[] = [];
  const walk = (s: ParsedSection) => {
    const hashes = '#'.repeat(Math.min(Math.max(s.depth, 1), 6));
    if (s.title) out.push(`${hashes} ${s.title}`);
    if (s.content) out.push(s.content);
    for (const child of s.children) walk(child);
  };
  for (const s of doc.sections) walk(s);
  return out.join('\n\n');
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}
