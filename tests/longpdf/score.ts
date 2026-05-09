import type {
  Question,
  BaselineRun,
  ScoredQuestion,
  RunSummary,
  RetrievalCandidate,
  Tier,
  DocId,
} from './types';

// Retrieval@k: TRUE iff any candidate's text or sectionLabel substring-matches
// any gold_section. Case-insensitive. Section anchors are written by humans,
// so we match leniently — `"Item 1A. Risk Factors"` should match a candidate
// labeled `"item 1a"` or `"risk factors"`.
export function retrievalHit(candidates: RetrievalCandidate[], goldSections: string[]): boolean {
  const haystacks = candidates.map(c => normalize(`${c.sectionLabel ?? ''} ${c.text}`));
  for (const gold of goldSections) {
    const needle = normalize(gold);
    if (!needle) continue;
    if (haystacks.some(h => h.includes(needle))) return true;
    // Also try the gold split on punctuation — "§3.2 Scaled Dot-Product
    // Attention" becomes ["3 2", "scaled dot product attention"]; either
    // half matching is good enough.
    for (const part of splitGold(needle)) {
      if (part.length >= 4 && haystacks.some(h => h.includes(part))) return true;
    }
  }
  return false;
}

export function scoreRun(
  run: BaselineRun,
  q: Question,
  judge: ScoredQuestion['judge'],
): ScoredQuestion {
  return {
    questionId: q.id,
    doc: q.doc,
    tier: q.tier,
    retrievalAtK: retrievalHit(run.candidates, q.gold_sections),
    judge,
  };
}

export function summarize(scored: ScoredQuestion[], baseline: BaselineRun['baseline'], k: number): RunSummary {
  const empty = () => ({ total: 0, retrievalAtK: 0, correct: 0, partial: 0, wrong: 0 });
  const byDoc: Record<DocId, ReturnType<typeof empty>> = {
    'filing.pdf': empty(),
    'manual.pdf': empty(),
    'paper.pdf': empty(),
  };
  const byTier: Record<Tier, ReturnType<typeof empty>> = {
    1: empty(), 2: empty(), 3: empty(),
  };
  const total = empty();

  for (const s of scored) {
    bump(total, s);
    bump(byDoc[s.doc], s);
    bump(byTier[s.tier], s);
  }

  return {
    baseline,
    k,
    total: total.total,
    retrievalAtK: total.retrievalAtK,
    correct: total.correct,
    partial: total.partial,
    wrong: total.wrong,
    byDoc,
    byTier,
  };
}

export function summaryToMarkdown(s: RunSummary): string {
  const pct = (n: number, d: number) => d ? `${Math.round((n / d) * 100)}%` : '—';
  const row = (label: string, x: ReturnType<typeof emptyAccum>) =>
    `| ${label} | ${x.total} | ${x.retrievalAtK} (${pct(x.retrievalAtK, x.total)}) | ${x.correct} (${pct(x.correct, x.total)}) | ${x.partial} | ${x.wrong} |`;

  const lines: string[] = [];
  lines.push(`## ${s.baseline} (k = ${s.k})`);
  lines.push('');
  lines.push('| slice | total | retrieval@k | correct | partial | wrong |');
  lines.push('|---|---:|---:|---:|---:|---:|');
  lines.push(row('overall', { total: s.total, retrievalAtK: s.retrievalAtK, correct: s.correct, partial: s.partial, wrong: s.wrong }));
  for (const d of ['filing.pdf', 'manual.pdf', 'paper.pdf'] as DocId[]) {
    lines.push(row(d, s.byDoc[d]));
  }
  for (const t of [1, 2, 3] as Tier[]) {
    lines.push(row(`tier ${t}`, s.byTier[t]));
  }
  return lines.join('\n');
}

function bump(acc: ReturnType<typeof emptyAccum>, s: ScoredQuestion): void {
  acc.total++;
  if (s.retrievalAtK) acc.retrievalAtK++;
  acc[s.judge.verdict]++;
}

function emptyAccum() {
  return { total: 0, retrievalAtK: 0, correct: 0, partial: 0, wrong: 0 };
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function splitGold(normalized: string): string[] {
  return normalized.split(/\s+/).reduce<string[]>((acc, _, i, arr) => {
    if (i === 0) acc.push(arr.slice(0, 4).join(' '));
    return acc;
  }, []).concat(normalized);
}
