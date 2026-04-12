import type { KnowledgeGraph, GraphNode, NodeId, DirectedEdge, UndirectedEdge } from '@/core/types';

// LLM-powered node enrichment
// Adds synthesis, contextual explanation, and confidence annotation to each node
// Runs as an optional post-construction pass (costs ~$0.50-2 per dataset)

export interface EnrichedNodeData {
  synthesis: string; // One-sentence distillation of what this node means
  context: string; // How this node relates to its neighbors
  sourceQuality: 'primary' | 'secondary' | 'inference' | 'unknown';
}

export interface EnrichmentResult {
  enrichedCount: number;
  skippedCount: number;
  totalCost: number; // Estimated token cost
}

// Build the enrichment prompt for a single node and its neighborhood
export function buildEnrichmentPrompt(
  node: GraphNode,
  neighbors: Array<{ node: GraphNode; edge: DirectedEdge | UndirectedEdge; direction: string }>,
  graphName: string
): string {
  const neighborDescriptions = neighbors.slice(0, 8).map(n => {
    const edgeType = 'type' in n.edge ? n.edge.type : 'related';
    const weight = n.edge.weight.toFixed(2);
    return `  - [${edgeType}, weight ${weight}, ${n.direction}] ${n.node.content.slice(0, 120)}`;
  }).join('\n');

  return `You are enriching a knowledge graph node. Provide exactly three things in JSON format.

Graph: "${graphName}"
Node type: ${node.type}
Node content: "${node.content}"
Node entities: ${node.entities.join(', ') || 'none'}

Connected nodes:
${neighborDescriptions || '  (no connections)'}

Respond with ONLY valid JSON, no markdown:
{
  "synthesis": "One sentence capturing what this node MEANS in context (not what it says, but why it matters)",
  "context": "2-3 sentences explaining how this node connects to its neighbors and what role it plays in the knowledge graph",
  "sourceQuality": "primary|secondary|inference|unknown"
}

Rules:
- synthesis should be insight, not repetition. "Turing's 1936 paper introduced computability" not "Paper was submitted in 1936"
- context should reference specific neighbor relationships
- sourceQuality: "primary" = first-hand account/data, "secondary" = reporting/citing, "inference" = derived/computed, "unknown" = unclear`;
}

// Get the neighborhood of a node (connected nodes via edges)
export function getNodeNeighborhood(
  graph: KnowledgeGraph,
  nodeId: NodeId,
  maxNeighbors: number = 8
): Array<{ node: GraphNode; edge: DirectedEdge | UndirectedEdge; direction: string }> {
  const neighbors: Array<{ node: GraphNode; edge: DirectedEdge | UndirectedEdge; direction: string }> = [];

  // Outgoing directed edges
  for (const edge of graph.directedEdges.values()) {
    if (edge.from === nodeId) {
      const neighbor = graph.nodes.get(edge.to);
      if (neighbor) neighbors.push({ node: neighbor, edge, direction: 'outgoing' });
    }
    if (edge.to === nodeId) {
      const neighbor = graph.nodes.get(edge.from);
      if (neighbor) neighbors.push({ node: neighbor, edge, direction: 'incoming' });
    }
    if (neighbors.length >= maxNeighbors * 2) break;
  }

  // Undirected edges
  for (const edge of graph.undirectedEdges.values()) {
    if (edge.nodes[0] === nodeId) {
      const neighbor = graph.nodes.get(edge.nodes[1]);
      if (neighbor) neighbors.push({ node: neighbor, edge, direction: 'undirected' });
    } else if (edge.nodes[1] === nodeId) {
      const neighbor = graph.nodes.get(edge.nodes[0]);
      if (neighbor) neighbors.push({ node: neighbor, edge, direction: 'undirected' });
    }
    if (neighbors.length >= maxNeighbors * 2) break;
  }

  // Sort by edge weight and take top N
  neighbors.sort((a, b) => b.edge.weight - a.edge.weight);
  return neighbors.slice(0, maxNeighbors);
}

// Parse the LLM response into enrichment data
export function parseEnrichmentResponse(response: string): EnrichedNodeData | null {
  try {
    // Try to extract JSON from the response (handle markdown code blocks)
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.synthesis || !parsed.context) return null;

    return {
      synthesis: parsed.synthesis,
      context: parsed.context,
      sourceQuality: parsed.sourceQuality || 'unknown',
    };
  } catch {
    return null;
  }
}

// Batch enrichment: collect nodes that need enrichment
export function getEnrichmentCandidates(
  graph: KnowledgeGraph,
  maxCandidates: number = 200
): NodeId[] {
  const candidates: Array<{ id: NodeId; priority: number }> = [];

  for (const [nodeId, node] of graph.nodes) {
    // Skip structural, already-enriched, and low-value nodes
    if (node.type === 'document' || node.type === 'section') continue;
    if (node.metadata.synthesis) continue; // Already enriched
    if (node.content.length < 30) continue; // Too short to be meaningful

    // Priority: high-confidence, frequently accessed, well-connected nodes first
    const connectionCount = countConnections(graph, nodeId);
    const priority = node.confidence * (1 + node.accessCount * 0.1) * (1 + connectionCount * 0.05);

    candidates.push({ id: nodeId, priority });
  }

  candidates.sort((a, b) => b.priority - a.priority);
  return candidates.slice(0, maxCandidates).map(c => c.id);
}

function countConnections(graph: KnowledgeGraph, nodeId: NodeId): number {
  let count = 0;
  for (const edge of graph.directedEdges.values()) {
    if (edge.from === nodeId || edge.to === nodeId) count++;
  }
  for (const edge of graph.undirectedEdges.values()) {
    if (edge.nodes[0] === nodeId || edge.nodes[1] === nodeId) count++;
  }
  return count;
}

// Apply enrichment data to a node
export function applyEnrichment(node: GraphNode, data: EnrichedNodeData): void {
  node.metadata.synthesis = data.synthesis;
  node.metadata.context = data.context;
  node.metadata.sourceQuality = data.sourceQuality;
  node.metadata.enrichedAt = Date.now();
}
