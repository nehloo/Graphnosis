/**
 * Ablation: max-score-wins vs additive path accumulation in the dual-graph traverser.
 *
 * Mechanism-level evidence for the bounded-influence / hub-independence property
 * (candidate Theorem 3). Graph, seeds, decay, hop limit, top-K, and the temporal pass are
 * held IDENTICAL; only the score-combination rule changes:
 *   max-wins  : nodeScores[v] = max(existing, neighborScore)   <- the shipped traverser
 *   additive  : nodeScores[v] = existing + neighborScore       <- spreading-activation / PPR-style mass
 *
 * The max-wins arm calls the REAL traverseGraph (src/core/query/traverser.ts).
 * The additive arm is that function transcribed verbatim with ONLY the three score-update
 * sites changed (marked  // <<ADDITIVE>> ). Everything else — adjacency build, FIFO BFS,
 * visited guard, temporal multiplier, top-K, edge filter — is line-for-line identical.
 *
 * Run:  pnpm tsx tests/ablation-scoring/maxwins-vs-additive.ts   (from the SDK repo root)
 */
import { traverseGraph } from '@/core/query/traverser';
import { MAX_TRAVERSAL_HOPS, DECAY_FACTOR, TOP_K_NODES } from '@/core/constants';
import type { KnowledgeGraph, GraphNode, DirectedEdge, UndirectedEdge, NodeId } from '@/core/types';
import type { ScoredSeed } from '@/core/query/seed-finder';

const FILLERS = 15; // popularity hub fans out to this many weakly-similar nodes

// ---- controlled graph -------------------------------------------------------
// seed --causes:0.85--> relA --causes:0.9--> relB        (the real answer chain)
// seed ~similar-to:0.4~ f0..fN                            (weak noise neighbourhood)
// fi   ~shares-entity:0.5~ hub  (for every fi)            (a high-degree popularity artifact)
//
// Under max-wins the hub's score is its single best weak edge; under additive it sums the
// whole fan-in. 19 nodes total (< TOP_K=20), so no node is truncated from the score map.
function buildGraph(): KnowledgeGraph {
  const now = Date.now();
  const node = (id: string): GraphNode => ({
    id,
    content: id,
    contentHash: id,
    type: 'fact',
    source: { file: 'ablation', offset: 0 },
    entities: [id],
    metadata: {},
    level: 0,
    confidence: 1.0,        // uniform -> temporal multiplier is a uniform x1.3, ranking-neutral
    createdAt: now,
    lastAccessedAt: now,    // fresh -> recency band <1d -> x1.3 for every node
    accessCount: 0,
  }) as GraphNode;

  const nodes = new Map<NodeId, GraphNode>();
  for (const id of ['seed', 'relA', 'relB', 'hub']) nodes.set(id, node(id));
  for (let i = 0; i < FILLERS; i++) nodes.set(`f${i}`, node(`f${i}`));

  const directedEdges = new Map<string, DirectedEdge>();
  const d = (id: string, from: string, to: string, weight: number): void => {
    directedEdges.set(id, { id, from, to, type: 'causes', weight } as DirectedEdge);
  };
  d('d1', 'seed', 'relA', 0.85);
  d('d2', 'relA', 'relB', 0.9);

  const undirectedEdges = new Map<string, UndirectedEdge>();
  const u = (id: string, a: string, b: string, type: 'similar-to' | 'shares-entity', weight: number): void => {
    undirectedEdges.set(id, { id, nodes: [a, b], type, weight } as UndirectedEdge);
  };
  for (let i = 0; i < FILLERS; i++) {
    u(`s${i}`, 'seed', `f${i}`, 'similar-to', 0.4);
    u(`h${i}`, `f${i}`, 'hub', 'shares-entity', 0.5);
  }

  return {
    id: 'g_ablation',
    name: 'ablation',
    nodes,
    directedEdges,
    undirectedEdges,
    levels: 0,
    metadata: { createdAt: now, updatedAt: now, version: 1, nodeCount: nodes.size } as KnowledgeGraph['metadata'],
  } as KnowledgeGraph;
}

// ---- additive arm: traverseGraph with max -> sum at the 3 update sites -------
function additiveTraverse(graph: KnowledgeGraph, seeds: ScoredSeed[]): Map<NodeId, number> {
  const nodeScores = new Map<NodeId, number>();
  const visited = new Set<NodeId>();
  const outEdges = new Map<NodeId, DirectedEdge[]>();
  const inEdges = new Map<NodeId, DirectedEdge[]>();
  const undirectedAdj = new Map<NodeId, UndirectedEdge[]>();

  for (const edge of graph.directedEdges.values()) {
    (outEdges.get(edge.from) ?? outEdges.set(edge.from, []).get(edge.from)!).push(edge);
    (inEdges.get(edge.to) ?? inEdges.set(edge.to, []).get(edge.to)!).push(edge);
  }
  for (const edge of graph.undirectedEdges.values()) {
    for (const nodeId of edge.nodes) {
      (undirectedAdj.get(nodeId) ?? undirectedAdj.set(nodeId, []).get(nodeId)!).push(edge);
    }
  }

  type QueueItem = { nodeId: NodeId; hop: number; score: number };
  const queue: QueueItem[] = seeds.map(s => ({ nodeId: s.nodeId, hop: 0, score: s.score }));
  for (const seed of seeds) nodeScores.set(seed.nodeId, seed.score);

  while (queue.length > 0) {
    const { nodeId, hop, score } = queue.shift()!;
    if (hop >= MAX_TRAVERSAL_HOPS) continue;
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);
    const nextHop = hop + 1;
    const decayedScore = score * DECAY_FACTOR;

    for (const edge of outEdges.get(nodeId) ?? []) {
      const neighborScore = decayedScore * edge.weight;
      const existing = nodeScores.get(edge.to) ?? 0;
      nodeScores.set(edge.to, existing + neighborScore);                    // <<ADDITIVE>>
      queue.push({ nodeId: edge.to, hop: nextHop, score: neighborScore });
    }
    for (const edge of inEdges.get(nodeId) ?? []) {
      const neighborScore = decayedScore * edge.weight * 0.5;
      const existing = nodeScores.get(edge.from) ?? 0;
      nodeScores.set(edge.from, existing + neighborScore);                  // <<ADDITIVE>>
      queue.push({ nodeId: edge.from, hop: nextHop, score: neighborScore });
    }
    for (const edge of undirectedAdj.get(nodeId) ?? []) {
      const neighbor = edge.nodes[0] === nodeId ? edge.nodes[1] : edge.nodes[0];
      const neighborScore = decayedScore * edge.weight;
      const existing = nodeScores.get(neighbor) ?? 0;
      nodeScores.set(neighbor, existing + neighborScore);                   // <<ADDITIVE>>
      queue.push({ nodeId: neighbor, hop: nextHop, score: neighborScore });
    }
  }

  // identical temporal pass
  const now = Date.now();
  const ONE_DAY = 86_400_000;
  for (const [nodeId, baseScore] of nodeScores) {
    const node = graph.nodes.get(nodeId);
    if (!node) continue;
    let m = 1.0;
    if (node.lastAccessedAt) {
      const days = (now - node.lastAccessedAt) / ONE_DAY;
      if (days < 1) m *= 1.3; else if (days < 7) m *= 1.1;
    }
    if (node.accessCount > 10) m *= 1.2; else if (node.accessCount > 3) m *= 1.1;
    m *= node.confidence;
    if (node.validUntil && now > node.validUntil) m *= 0.3;
    nodeScores.set(nodeId, baseScore * m);
    node.lastAccessedAt = now;
    node.accessCount++;
  }
  return nodeScores;
}

// ---- run + report -----------------------------------------------------------
const seeds: ScoredSeed[] = [{ nodeId: 'seed', score: 1.0 }];

delete process.env.GNOSIS_SCORE_RULE;
const maxWins = traverseGraph(buildGraph(), seeds).scores;       // real traverser, default max-wins
const additive = additiveTraverse(buildGraph(), seeds);          // inline additive reference
process.env.GNOSIS_SCORE_RULE = 'additive';
const realAdditive = traverseGraph(buildGraph(), seeds).scores;  // real traverser via the gated branch
delete process.env.GNOSIS_SCORE_RULE;

function ranked(scores: Map<NodeId, number>): Array<[string, number, number]> {
  const arr = Array.from(scores.entries()).sort((a, b) => b[1] - a[1]);
  return arr.map(([id, sc], i) => [id, sc, i + 1]);
}
const rankOf = (r: Array<[string, number, number]>, id: string) => r.find(x => x[0] === id)!;

const rM = ranked(maxWins);
const rA = ranked(additive);

const fmt = (r: Array<[string, number, number]>, n = 6) =>
  r.slice(0, n).map(([id, sc, rk]) => `   #${rk}  ${id.padEnd(5)} ${sc.toFixed(3)}`).join('\n');

const hM = rankOf(rM, 'hub'), hA = rankOf(rA, 'hub');
const aM = rankOf(rM, 'relA'), aA = rankOf(rA, 'relA');

console.log(`\nAblation: max-score-wins vs additive  (DECAY_FACTOR=${DECAY_FACTOR}, MAX_HOPS=${MAX_TRAVERSAL_HOPS}, TOP_K=${TOP_K_NODES})`);
console.log(`Graph: 1 seed, answer chain relA<-relB, ${FILLERS} similar-to fillers, 1 shares-entity hub (in-degree ${FILLERS}).\n`);
console.log(`MAX-WINS (shipped) top 6:\n${fmt(rM)}`);
console.log(`\nADDITIVE top 6:\n${fmt(rA)}`);
console.log(`\n--- the popularity hub (irrelevant, in-degree ${FILLERS}) ---`);
console.log(`  max-wins :  rank ${hM[2]}/${rM.length}   score ${hM[1].toFixed(3)}`);
console.log(`  additive :  rank ${hA[2]}/${rA.length}   score ${hA[1].toFixed(3)}`);
console.log(`--- the real answer node relA ---`);
console.log(`  max-wins :  rank ${aM[2]}   score ${aM[1].toFixed(3)}`);
console.log(`  additive :  rank ${aA[2]}   score ${aA[1].toFixed(3)}`);
const displaced = aA[2] > hA[2];
console.log(`\nVerdict: additive lifts the in-degree-${FILLERS} hub ${hM[2]}->${hA[2]} (x${(hA[1] / hM[1]).toFixed(1)} score); ` +
  `answer relA ${displaced ? 'BURIED below' : 'still above'} the hub under additive (${aA[2]} vs ${hA[2]}). ` +
  `Max-wins keeps the hub at rank ${hM[2]} and relA at rank ${aM[2]}.`);

const hRA = rankOf(ranked(realAdditive), 'hub');
const match = Math.abs(hRA[1] - hA[1]) < 1e-9;
console.log(`\nFaithfulness — real traverser with GNOSIS_SCORE_RULE=additive (the end-to-end hook):`);
console.log(`  hub score ${hRA[1].toFixed(3)} (real gated branch) vs ${hA[1].toFixed(3)} (inline reference)  ->  ${match ? 'MATCH ✓' : 'MISMATCH ✗'}`);

// ── Assertions — exit non-zero if any Theorem 3 invariant breaks (CI-gate) ──
const invariants = {
  faithful: match,                    // the gated GNOSIS_SCORE_RULE=additive branch == the inline reference
  maxWinsHubLast: hM[2] === rM.length, // max-wins keeps the in-degree-15 hub dead last (no inflation)
  additiveInflatesHub: hA[2] < hM[2],  // additive promotes it — the failure mode the max rule prevents
  answerAboveHubMaxWins: aM[2] < hM[2],// the real answer outranks the hub under max-wins
};
console.log(`\nInvariants: ${JSON.stringify(invariants)}`);
if (!Object.values(invariants).every(Boolean)) {
  console.error('ABLATION ASSERTION FAILED — a Theorem 3 invariant broke (see above).');
  process.exit(1);
}
console.log('All Theorem 3 ablation invariants hold. ✓');
