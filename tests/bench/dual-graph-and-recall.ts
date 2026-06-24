/**
 * Micro-benchmark: dual-graph coverage (C2) + isolated recall latency + .gai-vs-JSON size.
 *
 *   pnpm tsx tests/bench/dual-graph-and-recall.ts \
 *     [--questions 50] [--reps 25] [--queries 40] [--seeds 500] [--hops 3] [--seed 42]
 *
 * Builds ONE aggregate KnowledgeGraph from the first N LongMemEval questions'
 * haystack sessions (public corpus) — a heterogeneous cortex in the hundreds-
 * to-thousands-of-nodes regime the system is calibrated for — then reports three
 * measurements the LongMemEval accuracy runner bundles together and cannot isolate:
 *
 *   (C2)  dual-graph coverage strictness   — paper §5.2 / Observation 1
 *   (#5a) warm recall latency              — queryGraph() only, no LLM, no rebuild — §12.5
 *   (#5b) .gai (MessagePack) vs JSON size  — same graph serialized both ways — §12.5
 *
 * Fully deterministic: fixed dataset slice + seeded RNG for seed sampling.
 * No network, no API keys, no LLM. Reproducible by anyone with the public dataset.
 */
import os from 'node:os';
import { writeFileSync, mkdirSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { loadDataset } from '../longmemeval/official/dataset';
import { buildSessionDocsForQuestion } from '../longmemeval/official/ingest';
import { buildGraph } from '@/core/graph/graph-builder';
import { queryGraph } from '@/core/query/query-engine';
import { buildSynonymMap } from '@/core/query/synonym-expander';
import { writeGai } from '@/core/format/gai-writer';
import { toSerializable } from '@/core/graph/graph-store';
import { MAX_TRAVERSAL_HOPS } from '@/core/constants';
import type { NodeId } from '@/core/types';

// ---------- args ----------
function numArg(name: string, def: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? parseInt(process.argv[i + 1], 10)
    : def;
}
function strArg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : def;
}
const N_QUESTIONS = numArg('questions', 12);
const REPS = numArg('reps', 25);
const N_QUERIES = numArg('queries', 40);
const N_SEEDS = numArg('seeds', 500);
const HOPS = numArg('hops', MAX_TRAVERSAL_HOPS);
const RNG_SEED = numArg('seed', 42);
const DATASET = strArg('dataset', 'data/longmemeval/longmemeval_s.json');

// ---------- helpers ----------
function mulberry32(a: number) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(RNG_SEED);
const asc = (xs: number[]) => [...xs].sort((a, b) => a - b);
const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = asc(xs);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pctl = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = asc(xs);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const r1 = (x: number) => Math.round(x * 10) / 10;
const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

// ---------- build the aggregate graph ----------
console.log(`[bench] loading ${DATASET} …`);
const dataset = loadDataset(DATASET);
const subset = dataset.slice(0, Math.min(N_QUESTIONS, dataset.length));
const docs = subset.flatMap((q) => buildSessionDocsForQuestion(q));
console.log(`[bench] building graph from ${subset.length} questions (${docs.length} docs) …`);
const tBuild = performance.now();
const graph = buildGraph(docs, 'bench');
const buildMs = performance.now() - tBuild;
const tfidf = graph.tfidfIndex;

const nNodes = graph.nodes.size;
const nDir = graph.directedEdges.size;
const nUndir = graph.undirectedEdges.size;
console.log(`[bench] graph: ${nNodes} nodes, ${nDir} directed + ${nUndir} undirected edges (built in ${r1(buildMs)} ms)`);

// ---------- C2: 1-hop edge-pair disjointness ----------
// How many node pairs are *directly connected* by each edge class, and how much
// the two classes overlap. Low overlap => a single-relation store misses the
// other class wholesale.
const D = new Set<string>();
for (const e of graph.directedEdges.values()) D.add(pairKey(e.from, e.to));
const U = new Set<string>();
for (const e of graph.undirectedEdges.values()) U.add(pairKey(e.nodes[0], e.nodes[1]));
let overlap1 = 0;
for (const k of D) if (U.has(k)) overlap1++;
const onlyD1 = D.size - overlap1;
const onlyU1 = U.size - overlap1;
const union1 = D.size + U.size - overlap1;

// ---------- C2: k-hop reachability strictness ----------
// Of the nodes reachable within HOPS hops using BOTH edge classes (the union
// graph), what fraction are reachable only-via-directed, only-via-undirected,
// only-by-alternating-classes (mixed paths), or by both classes independently?
const dirAdj = new Map<NodeId, NodeId[]>(); // directed, direction-respecting
const undAdj = new Map<NodeId, NodeId[]>(); // undirected, both ways
const uniAdj = new Map<NodeId, NodeId[]>(); // union
const push = (m: Map<NodeId, NodeId[]>, a: NodeId, b: NodeId) => {
  const l = m.get(a);
  if (l) l.push(b);
  else m.set(a, [b]);
};
for (const e of graph.directedEdges.values()) {
  push(dirAdj, e.from, e.to);
  push(uniAdj, e.from, e.to);
}
for (const e of graph.undirectedEdges.values()) {
  const [a, b] = e.nodes;
  push(undAdj, a, b);
  push(undAdj, b, a);
  push(uniAdj, a, b);
  push(uniAdj, b, a);
}
function bfs(adj: Map<NodeId, NodeId[]>, seed: NodeId, hops: number): Set<NodeId> {
  const seen = new Set<NodeId>([seed]);
  let frontier: NodeId[] = [seed];
  for (let h = 0; h < hops && frontier.length; h++) {
    const next: NodeId[] = [];
    for (const n of frontier) for (const m of adj.get(n) ?? []) if (!seen.has(m)) { seen.add(m); next.push(m); }
    frontier = next;
  }
  seen.delete(seed);
  return seen;
}
const allNodes = [...graph.nodes.keys()];
let seeds: NodeId[];
if (allNodes.length <= N_SEEDS) {
  seeds = allNodes;
} else {
  const picked = new Set<number>();
  while (picked.size < N_SEEDS) picked.add(Math.floor(rand() * allNodes.length));
  seeds = [...picked].map((i) => allNodes[i]);
}
const reachD: number[] = [];
const reachU: number[] = [];
const reachUni: number[] = [];
const fracOnlyD: number[] = [];
const fracOnlyU: number[] = [];
const fracMix: number[] = [];
const fracBoth: number[] = [];
let connectedSeeds = 0;
for (const s of seeds) {
  const rD = bfs(dirAdj, s, HOPS);
  const rU = bfs(undAdj, s, HOPS);
  const rUni = bfs(uniAdj, s, HOPS);
  reachD.push(rD.size);
  reachU.push(rU.size);
  reachUni.push(rUni.size);
  if (rUni.size === 0) continue;
  connectedSeeds++;
  let oD = 0, oU = 0, mix = 0, both = 0;
  for (const n of rUni) {
    const inD = rD.has(n);
    const inU = rU.has(n);
    if (inD && inU) both++;
    else if (inD) oD++;
    else if (inU) oU++;
    else mix++; // only reachable by alternating directed and undirected edges
  }
  fracOnlyD.push((100 * oD) / rUni.size);
  fracOnlyU.push((100 * oU) / rUni.size);
  fracMix.push((100 * mix) / rUni.size);
  fracBoth.push((100 * both) / rUni.size);
}

// ---------- #5a: warm recall latency (no LLM, no rebuild) ----------
const queries = subset.slice(0, Math.min(N_QUERIES, subset.length)).map((q) => q.question);
for (const q of queries) queryGraph(graph, tfidf, q, {}); // warm-up (discarded)
const lat: number[] = [];
for (let r = 0; r < REPS; r++) {
  for (const q of queries) {
    const t = performance.now();
    queryGraph(graph, tfidf, q, {});
    lat.push(performance.now() - t);
  }
}
// queryGraph() rebuilds the synonym map on every call, but that map is a pure
// function of the graph (not the query), so a persistent recall server caches
// it once per graph. Measure it separately to report the query-dependent cost.
const synMs: number[] = [];
for (let i = 0; i < 11; i++) {
  const t = performance.now();
  buildSynonymMap(graph);
  synMs.push(performance.now() - t);
}
const synMedian = median(synMs);
const queryDependentMs = Math.max(0, median(lat) - synMedian);

// ---------- #5b: .gai (MessagePack) vs JSON size ----------
// Both serialize the identical toSerializable(graph) payload; .gai here is the
// unencrypted MessagePack container. On-disk .gai is XChaCha20-encrypted, which
// preserves length (+~16-byte tag) — so this is the format-overhead comparison.
const gaiBytes = writeGai(graph).length;
const jsonBytes = Buffer.byteLength(JSON.stringify(toSerializable(graph)), 'utf8');

// ---------- hardware ----------
const cpu = os.cpus()[0]?.model?.trim() ?? 'unknown';
const cores = os.cpus().length;
const ramGB = (os.totalmem() / 1e9).toFixed(1);

// ---------- report ----------
const kb = (b: number) => +(b / 1024).toFixed(1);
const out = {
  config: { questions: subset.length, reps: REPS, queries: queries.length, seeds: seeds.length, hops: HOPS, rngSeed: RNG_SEED, dataset: DATASET },
  hardware: { cpu, cores, ramGB: +ramGB, node: process.version },
  graph: { nodes: nNodes, directedEdges: nDir, undirectedEdges: nUndir, buildMs: r1(buildMs) },
  c2_oneHop: {
    directedPairs: D.size,
    undirectedPairs: U.size,
    overlap: overlap1,
    onlyDirected: onlyD1,
    onlyUndirected: onlyU1,
    unionPairs: union1,
    pctOnlyDirected: union1 ? r1((100 * onlyD1) / union1) : 0,
    pctOnlyUndirected: union1 ? r1((100 * onlyU1) / union1) : 0,
    pctOverlap: union1 ? r1((100 * overlap1) / union1) : 0,
  },
  c2_reachability: {
    connectedSeeds,
    medianReachDirected: median(reachD),
    medianReachUndirected: median(reachU),
    medianReachUnion: median(reachUni),
    medianPctOnlyDirected: r1(median(fracOnlyD)),
    medianPctOnlyUndirected: r1(median(fracOnlyU)),
    medianPctMixedOnly: r1(median(fracMix)),
    medianPctBothClasses: r1(median(fracBoth)),
  },
  recallLatencyMs: {
    n: lat.length,
    median: r1(median(lat)),
    p95: r1(pctl(lat, 95)),
    mean: r1(mean(lat)),
    synonymMapBuildMedian: r1(synMedian), // query-independent, cacheable per graph
    queryDependentMedian: r1(queryDependentMs), // steady-state recall once map is cached
  },
  size: {
    gaiBytes,
    jsonBytes,
    gaiKB: kb(gaiBytes),
    jsonKB: kb(jsonBytes),
    jsonToGaiRatio: +(jsonBytes / gaiBytes).toFixed(2),
    gaiPctOfJson: r1((100 * gaiBytes) / jsonBytes),
  },
};

console.log('\n========================= RESULTS =========================');
console.log(`Hardware : ${cpu} (${cores} cores, ${ramGB} GB), Node ${process.version}`);
console.log(`Graph    : ${nNodes} nodes · ${nDir} directed · ${nUndir} undirected edges`);
console.log('\n--- C2: dual-graph coverage (Observation 1, §5.2) ---');
console.log(`1-hop pairs: directed=${D.size}, undirected=${U.size}, overlap=${overlap1}`);
console.log(`  → only-directed ${out.c2_oneHop.pctOnlyDirected}% · only-undirected ${out.c2_oneHop.pctOnlyUndirected}% · both ${out.c2_oneHop.pctOverlap}% of ${union1} connected pairs`);
console.log(`${HOPS}-hop reachability (median over ${connectedSeeds} connected seeds):`);
console.log(`  reach via directed-only=${out.c2_reachability.medianReachDirected}, undirected-only=${out.c2_reachability.medianReachUndirected}, union=${out.c2_reachability.medianReachUnion}`);
console.log(`  of union-reachable nodes: only-directed ${out.c2_reachability.medianPctOnlyDirected}% · only-undirected ${out.c2_reachability.medianPctOnlyUndirected}% · only-by-mixing ${out.c2_reachability.medianPctMixedOnly}% · both-classes ${out.c2_reachability.medianPctBothClasses}%`);
console.log('\n--- #5a: warm recall latency (queryGraph only, no LLM) ---');
console.log(`  full call:  median ${out.recallLatencyMs.median} ms · p95 ${out.recallLatencyMs.p95} ms · mean ${out.recallLatencyMs.mean} ms (${lat.length} calls)`);
console.log(`  of which:   synonym-map build ${out.recallLatencyMs.synonymMapBuildMedian} ms (query-independent, cached per graph in a server)`);
console.log(`  steady-state query-dependent recall ≈ ${out.recallLatencyMs.queryDependentMedian} ms`);
console.log('\n--- #5b: on-disk format size (same graph) ---');
console.log(`  .gai (MessagePack) ${out.size.gaiKB} KB · JSON ${out.size.jsonKB} KB · .gai is ${out.size.gaiPctOfJson}% of JSON (${out.size.jsonToGaiRatio}× smaller)`);
console.log('===========================================================\n');

mkdirSync('benchmarks', { recursive: true });
writeFileSync('benchmarks/dual-graph-and-recall.json', JSON.stringify(out, null, 2));
console.log('[bench] wrote benchmarks/dual-graph-and-recall.json');
