import type { KnowledgeGraph, GraphNode, DirectedEdge, DirectedEdgeType, UndirectedEdge, NodeId } from '@/core/types';
import { MAX_TRAVERSAL_HOPS, DECAY_FACTOR, TOP_K_NODES } from '@/core/constants';
import type { ScoredSeed } from './seed-finder';

export interface TraversalResult {
  nodes: GraphNode[];
  directedEdges: DirectedEdge[];
  undirectedEdges: UndirectedEdge[];
  scores: Map<NodeId, number>;
}

export interface TraverseOptions {
  // Directed-edge types that BFS is not allowed to cross. Used by the
  // router to block 'summarizes' on single-session-user/assistant queries
  // so a summary node (if it slips into the seed pool) can't pull every
  // turn of its session into the subgraph.
  blockedEdgeTypes?: Set<DirectedEdgeType>;
}

export function traverseGraph(
  graph: KnowledgeGraph,
  seeds: ScoredSeed[],
  maxHops: number = MAX_TRAVERSAL_HOPS,
  maxNodes: number = TOP_K_NODES,
  opts: TraverseOptions = {}
): TraversalResult {
  const blocked = opts.blockedEdgeTypes;
  const nodeScores = new Map<NodeId, number>();
  const visited = new Set<NodeId>();

  // Build adjacency lists for fast traversal
  const outEdges = new Map<NodeId, DirectedEdge[]>();
  const inEdges = new Map<NodeId, DirectedEdge[]>();
  const undirectedAdj = new Map<NodeId, UndirectedEdge[]>();

  for (const edge of graph.directedEdges.values()) {
    const out = outEdges.get(edge.from) || [];
    out.push(edge);
    outEdges.set(edge.from, out);

    const inc = inEdges.get(edge.to) || [];
    inc.push(edge);
    inEdges.set(edge.to, inc);
  }

  for (const edge of graph.undirectedEdges.values()) {
    for (const nodeId of edge.nodes) {
      const adj = undirectedAdj.get(nodeId) || [];
      adj.push(edge);
      undirectedAdj.set(nodeId, adj);
    }
  }

  // BFS from each seed node with score decay
  type QueueItem = { nodeId: NodeId; hop: number; score: number };
  const queue: QueueItem[] = seeds.map(s => ({
    nodeId: s.nodeId,
    hop: 0,
    score: s.score,
  }));

  // Initialize seed scores
  for (const seed of seeds) {
    nodeScores.set(seed.nodeId, seed.score);
  }

  while (queue.length > 0) {
    const { nodeId, hop, score } = queue.shift()!;

    if (hop >= maxHops) continue;
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);

    const nextHop = hop + 1;
    const decayedScore = score * DECAY_FACTOR;

    // Traverse directed edges (outgoing)
    for (const edge of outEdges.get(nodeId) || []) {
      if (blocked && blocked.has(edge.type)) continue;
      const neighborScore = decayedScore * edge.weight;
      const existing = nodeScores.get(edge.to) || 0;
      if (neighborScore > existing) {
        nodeScores.set(edge.to, neighborScore);
        queue.push({ nodeId: edge.to, hop: nextHop, score: neighborScore });
      }
    }

    // Traverse directed edges (incoming — follow edges backward)
    for (const edge of inEdges.get(nodeId) || []) {
      if (blocked && blocked.has(edge.type)) continue;
      const neighborScore = decayedScore * edge.weight * 0.5; // Lower weight for backward traversal
      const existing = nodeScores.get(edge.from) || 0;
      if (neighborScore > existing) {
        nodeScores.set(edge.from, neighborScore);
        queue.push({ nodeId: edge.from, hop: nextHop, score: neighborScore });
      }
    }

    // Traverse undirected edges
    for (const edge of undirectedAdj.get(nodeId) || []) {
      const neighbor = edge.nodes[0] === nodeId ? edge.nodes[1] : edge.nodes[0];
      const neighborScore = decayedScore * edge.weight;
      const existing = nodeScores.get(neighbor) || 0;
      if (neighborScore > existing) {
        nodeScores.set(neighbor, neighborScore);
        queue.push({ nodeId: neighbor, hop: nextHop, score: neighborScore });
      }
    }
  }

  // Apply temporal scoring boost: recently accessed and frequently accessed nodes score higher
  const now = Date.now();
  const ONE_DAY = 86_400_000;

  for (const [nodeId, baseScore] of nodeScores) {
    const node = graph.nodes.get(nodeId);
    if (!node) continue;

    let temporalMultiplier = 1.0;

    // Recency boost: nodes accessed in the last 24h get up to 1.3x
    if (node.lastAccessedAt) {
      const daysSinceAccess = (now - node.lastAccessedAt) / ONE_DAY;
      if (daysSinceAccess < 1) temporalMultiplier *= 1.3;
      else if (daysSinceAccess < 7) temporalMultiplier *= 1.1;
    }

    // Frequency boost: heavily accessed nodes get up to 1.2x
    if (node.accessCount > 10) temporalMultiplier *= 1.2;
    else if (node.accessCount > 3) temporalMultiplier *= 1.1;

    // Confidence factor: low-confidence (decayed) nodes score lower
    temporalMultiplier *= node.confidence;

    // Skip expired nodes
    if (node.validUntil && now > node.validUntil) {
      temporalMultiplier *= 0.3;
    }

    nodeScores.set(nodeId, baseScore * temporalMultiplier);

    // Update access stats
    node.lastAccessedAt = now;
    node.accessCount++;
  }

  // Collect top-K nodes by score
  const sortedNodes = Array.from(nodeScores.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxNodes);

  const selectedNodeIds = new Set(sortedNodes.map(([id]) => id));

  // Collect relevant edges (both endpoints must be in the selected set).
  // Blocked edge types are dropped from the serialized subgraph too — for
  // single-session questions, even a 'summarizes' edge already in the
  // selected set adds noise the LLM doesn't need.
  const relevantDirected: DirectedEdge[] = [];
  for (const edge of graph.directedEdges.values()) {
    if (blocked && blocked.has(edge.type)) continue;
    if (selectedNodeIds.has(edge.from) && selectedNodeIds.has(edge.to)) {
      relevantDirected.push(edge);
    }
  }

  const relevantUndirected: UndirectedEdge[] = [];
  for (const edge of graph.undirectedEdges.values()) {
    if (selectedNodeIds.has(edge.nodes[0]) && selectedNodeIds.has(edge.nodes[1])) {
      relevantUndirected.push(edge);
    }
  }

  // Collect the actual node objects
  const selectedNodes: GraphNode[] = [];
  for (const [nodeId] of sortedNodes) {
    const node = graph.nodes.get(nodeId);
    if (node) selectedNodes.push(node);
  }

  return {
    nodes: selectedNodes,
    directedEdges: relevantDirected,
    undirectedEdges: relevantUndirected,
    scores: new Map(sortedNodes),
  };
}
