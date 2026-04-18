import type { GraphNode, DirectedEdge, UndirectedEdge, NodeId, SubgraphContext } from '@/core/types';

// Serialize a subgraph into a token-efficient format for LLM prompts
// This is the key differentiator vs flat RAG chunks

export function serializeSubgraph(
  nodes: GraphNode[],
  directedEdges: DirectedEdge[],
  undirectedEdges: UndirectedEdge[],
  scores: Map<NodeId, number>
): SubgraphContext {
  const lines: string[] = [];

  lines.push(`=== KNOWLEDGE SUBGRAPH (${nodes.length} nodes, ${directedEdges.length + undirectedEdges.length} edges) ===`);
  lines.push('');

  // Nodes section — sorted by relevance score
  const sortedNodes = [...nodes].sort((a, b) => {
    const scoreA = scores.get(a.id) || 0;
    const scoreB = scores.get(b.id) || 0;
    return scoreB - scoreA;
  });

  // Build short ID mapping for readability
  const shortIds = new Map<NodeId, string>();
  sortedNodes.forEach((node, i) => {
    shortIds.set(node.id, `n${i + 1}`);
  });

  // Split session summaries out into their own block ahead of the turn
  // evidence. The LLM treats summaries as an index-level context (what
  // happened in each session) and turns as the ground-truth quotes.
  const summaryNodes = sortedNodes.filter(n => n.type === 'session-summary');
  const evidenceNodes = sortedNodes.filter(
    n => n.type !== 'session-summary' && n.type !== 'document' && n.type !== 'section'
  );

  if (summaryNodes.length > 0) {
    lines.push('--- SESSION SUMMARIES ---');
    for (const node of summaryNodes) {
      const shortId = shortIds.get(node.id)!;
      const score = (scores.get(node.id) || 0).toFixed(2);
      const sessionDate = node.metadata.sessionDate;
      const date = typeof sessionDate === 'string' && sessionDate ? `date:${sessionDate}` : '';
      const sid = node.metadata.sessionId;
      const sidTag = typeof sid === 'string' && sid ? `session:${sid}` : '';
      const tags = [sidTag, date].filter(Boolean).join('|');
      lines.push(`[${shortId}|summary|${score}${tags ? '|' + tags : ''}] ${node.content}`);
      // Surface the atomic claims so the LLM can enumerate countable events
      // directly (e.g. "I bought 30 lbs of coffee beans") rather than
      // inferring them from compressed prose.
      const rawClaims = node.metadata.claims;
      if (typeof rawClaims === 'string' && rawClaims.trim()) {
        const claims = rawClaims.split(' || ').map(c => c.trim()).filter(Boolean).slice(0, 10);
        if (claims.length > 0) {
          lines.push(`  claims: ${claims.join(' | ')}`);
        }
      }
    }
    lines.push('');
  }

  lines.push('--- NODES ---');
  for (const node of evidenceNodes) {
    const shortId = shortIds.get(node.id)!;
    const score = (scores.get(node.id) || 0).toFixed(2);
    const source = node.source.section ? `src:${node.source.section}` : '';
    // Surface the originating session date when available so the LLM can do
    // temporal reasoning (e.g., "how many days ago did I mention X").
    const sessionDate = node.metadata.sessionDate;
    const date = typeof sessionDate === 'string' && sessionDate ? `date:${sessionDate}` : '';
    const tags = [source, date].filter(Boolean).join('|');
    lines.push(`[${shortId}|${node.type}|${score}${tags ? '|' + tags : ''}] ${node.content}`);
  }

  // Directed edges
  if (directedEdges.length > 0) {
    lines.push('');
    lines.push('--- DIRECTED ---');
    for (const edge of directedEdges) {
      const from = shortIds.get(edge.from);
      const to = shortIds.get(edge.to);
      if (from && to) {
        lines.push(`${from} -[${edge.type}:${edge.weight.toFixed(1)}]-> ${to}`);
      }
    }
  }

  // Undirected edges
  if (undirectedEdges.length > 0) {
    lines.push('');
    lines.push('--- UNDIRECTED ---');
    for (const edge of undirectedEdges) {
      const a = shortIds.get(edge.nodes[0]);
      const b = shortIds.get(edge.nodes[1]);
      if (a && b) {
        lines.push(`${a} ~[${edge.type}:${edge.weight.toFixed(1)}]~ ${b}`);
      }
    }
  }

  const serialized = lines.join('\n');

  return {
    nodes,
    directedEdges,
    undirectedEdges,
    serialized,
  };
}
