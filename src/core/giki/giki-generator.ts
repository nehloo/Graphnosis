import type { KnowledgeGraph, GraphNode, NodeId } from '@/core/types';

// Giki generation layer (graph + giki): transforms graph subgraphs into human-readable
// topic pages with citations back to graph nodes

export interface GikiPage {
  title: string;
  slug: string;
  content: string; // Markdown with node citations
  nodeIds: NodeId[]; // All nodes used in this page
  generatedAt: number;
}

// Generate a giki page for a specific entity/topic by collecting all related nodes
export function generateGikiPage(
  graph: KnowledgeGraph,
  topic: string
): GikiPage {
  // Find all nodes mentioning this topic
  const topicLower = topic.toLowerCase();
  const relevantNodes: Array<{ node: GraphNode; relevance: number }> = [];

  for (const [, node] of graph.nodes) {
    if (node.type === 'document' || node.type === 'section') continue;

    let relevance = 0;

    // Entity match
    if (node.entities.some(e => e.toLowerCase().includes(topicLower))) {
      relevance += 0.5;
    }

    // Content match
    if (node.content.toLowerCase().includes(topicLower)) {
      relevance += 0.3;
    }

    // Person node with matching name
    if (node.type === 'person' && node.content.toLowerCase().includes(topicLower)) {
      relevance += 0.8;
    }

    // Boost enriched nodes
    if (node.metadata.synthesis) relevance += 0.1;

    // Boost high-confidence nodes
    relevance *= node.confidence;

    if (relevance > 0) {
      relevantNodes.push({ node, relevance });
    }
  }

  // Sort by relevance
  relevantNodes.sort((a, b) => b.relevance - a.relevance);
  const topNodes = relevantNodes.slice(0, 50);

  if (topNodes.length === 0) {
    return {
      title: topic,
      slug: slugify(topic),
      content: `# ${topic}\n\nNo information found in the knowledge graph for this topic.`,
      nodeIds: [],
      generatedAt: Date.now(),
    };
  }

  // Group nodes by type for structured output
  const definitions = topNodes.filter(n => n.node.type === 'definition');
  const events = topNodes.filter(n => n.node.type === 'event').sort((a, b) => {
    const yearA = extractYear(a.node.content);
    const yearB = extractYear(b.node.content);
    return (yearA || 9999) - (yearB || 9999);
  });
  const facts = topNodes.filter(n => n.node.type === 'fact');
  const claims = topNodes.filter(n => n.node.type === 'claim');
  const persons = topNodes.filter(n => n.node.type === 'person');
  const dataPoints = topNodes.filter(n => n.node.type === 'data-point');

  // Build the page
  const lines: string[] = [];
  const usedNodeIds: NodeId[] = [];

  lines.push(`# ${topic}\n`);

  // Lead section: definitions first
  if (definitions.length > 0) {
    for (const { node } of definitions.slice(0, 3)) {
      const synth = node.metadata.synthesis ? `*${node.metadata.synthesis}*\n\n` : '';
      lines.push(`${synth}${node.content} ^[node:${node.id}]^\n`);
      usedNodeIds.push(node.id);
    }
  } else if (facts.length > 0) {
    // Use the highest-relevance fact as the lead
    const lead = facts[0];
    const synth = lead.node.metadata.synthesis ? `*${lead.node.metadata.synthesis}*\n\n` : '';
    lines.push(`${synth}${lead.node.content} ^[node:${lead.node.id}]^\n`);
    usedNodeIds.push(lead.node.id);
  }

  // Related people
  if (persons.length > 0) {
    lines.push('## Key People\n');
    for (const { node } of persons.slice(0, 10)) {
      lines.push(`- **${node.content}** ^[node:${node.id}]^`);
      usedNodeIds.push(node.id);
    }
    lines.push('');
  }

  // Timeline (events sorted chronologically)
  if (events.length > 0) {
    lines.push('## Timeline\n');
    for (const { node } of events.slice(0, 15)) {
      const year = extractYear(node.content);
      const prefix = year ? `**${year}** — ` : '- ';
      const synth = node.metadata.synthesis ? ` _${node.metadata.synthesis}_` : '';
      lines.push(`${prefix}${node.content.slice(0, 200)}${synth} ^[node:${node.id}]^\n`);
      usedNodeIds.push(node.id);
    }
  }

  // Key facts
  if (facts.length > 1) {
    lines.push('## Key Facts\n');
    const startIdx = definitions.length > 0 ? 0 : 1; // Skip lead if used above
    for (const { node } of facts.slice(startIdx, 15)) {
      if (usedNodeIds.includes(node.id)) continue;
      const synth = node.metadata.synthesis ? ` _${node.metadata.synthesis}_` : '';
      lines.push(`- ${node.content.slice(0, 250)}${synth} ^[node:${node.id}]^\n`);
      usedNodeIds.push(node.id);
    }
  }

  // Data points
  if (dataPoints.length > 0) {
    lines.push('## Data\n');
    for (const { node } of dataPoints.slice(0, 10)) {
      lines.push(`- ${node.content.slice(0, 200)} ^[node:${node.id}]^`);
      usedNodeIds.push(node.id);
    }
    lines.push('');
  }

  // Claims (with lower confidence warning)
  if (claims.length > 0) {
    lines.push('## Claims & Attributions\n');
    lines.push('> *The following are attributed claims, not verified facts.*\n');
    for (const { node } of claims.slice(0, 5)) {
      lines.push(`- ${node.content.slice(0, 200)} (confidence: ${(node.confidence * 100).toFixed(0)}%) ^[node:${node.id}]^`);
      usedNodeIds.push(node.id);
    }
    lines.push('');
  }

  // Relationships section (from edges)
  const relationships = getTopicRelationships(graph, usedNodeIds, topic);
  if (relationships.length > 0) {
    lines.push('## Relationships\n');
    for (const rel of relationships.slice(0, 15)) {
      lines.push(`- ${rel}`);
    }
    lines.push('');
  }

  // Sources
  const sources = [...new Set(topNodes.map(n => n.node.source.file))];
  lines.push('## Sources\n');
  for (const source of sources) {
    lines.push(`- ${source}`);
  }
  lines.push('');

  // Footer
  lines.push('---');
  lines.push(`*Generated by Bignosis from ${usedNodeIds.length} graph nodes across ${sources.length} source(s).*`);
  lines.push(`*Node citations use ^[node:ID]^ format for traceability.*`);

  return {
    title: topic,
    slug: slugify(topic),
    content: lines.join('\n'),
    nodeIds: usedNodeIds,
    generatedAt: Date.now(),
  };
}

// Generate giki pages for all major entities in the graph
export function generateGikiIndex(graph: KnowledgeGraph): GikiPage[] {
  // Find top entities by mention count
  const entityCounts = new Map<string, number>();
  for (const [, node] of graph.nodes) {
    for (const entity of node.entities) {
      entityCounts.set(entity, (entityCounts.get(entity) || 0) + 1);
    }
  }

  // Top 30 entities
  const topEntities = Array.from(entityCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([entity]) => entity);

  // Also include person nodes
  for (const [, node] of graph.nodes) {
    if (node.type === 'person' && !topEntities.includes(node.content)) {
      topEntities.push(node.content);
    }
  }

  return topEntities.slice(0, 40).map(topic => generateGikiPage(graph, topic));
}

// Generate an index page linking to all giki pages
export function generateGikiIndexPage(pages: GikiPage[], graphName: string): string {
  const lines: string[] = [];

  lines.push(`# ${graphName} — Knowledge Giki\n`);
  lines.push(`Generated from the Bignosis knowledge graph. Each page traces back to specific graph nodes.\n`);
  lines.push(`## Pages (${pages.length})\n`);

  for (const page of pages) {
    lines.push(`- [${page.title}](${page.slug}.md) — ${page.nodeIds.length} nodes`);
  }

  lines.push('\n---');
  lines.push(`*Auto-generated by Bignosis giki layer. ${pages.reduce((s, p) => s + p.nodeIds.length, 0)} total node citations.*`);

  return lines.join('\n');
}

function getTopicRelationships(
  graph: KnowledgeGraph,
  nodeIds: NodeId[],
  topic: string
): string[] {
  const relationships: string[] = [];
  const nodeIdSet = new Set(nodeIds);

  for (const edge of graph.directedEdges.values()) {
    if (!nodeIdSet.has(edge.from) && !nodeIdSet.has(edge.to)) continue;
    if (edge.type === 'contains' || edge.type === 'precedes') continue; // Skip structural

    const fromNode = graph.nodes.get(edge.from);
    const toNode = graph.nodes.get(edge.to);
    if (!fromNode || !toNode) continue;

    const fromLabel = fromNode.content.slice(0, 60);
    const toLabel = toNode.content.slice(0, 60);
    relationships.push(`"${fromLabel}..." **${edge.type}** "${toLabel}..." (weight: ${edge.weight.toFixed(2)})`);
  }

  return relationships;
}

function extractYear(text: string): number | null {
  const match = text.match(/\b(1[0-9]{3}|20[0-2][0-9])\b/);
  return match ? parseInt(match[1]) : null;
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
