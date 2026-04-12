import type {
  KnowledgeGraph,
  GraphNode,
  DirectedEdge,
  NodeId,
  Contradiction,
  ConnectionDiscovery,
} from '@/core/types';
import { reflect } from '@/core/optimization/reflection';
import type { TfidfIndex } from '@/core/types';

// Reverse analysis engine: reads the graph and produces human-readable audit files

export interface AuditReport {
  entities: EntityReport[];
  contradictions: ContradictionReport[];
  discoveries: DiscoveryReport[];
  health: HealthReport;
  generatedAt: number;
}

export interface EntityReport {
  name: string;
  nodeId?: NodeId;
  factCount: number;
  sources: string[];
  relatedPersons: string[];
  facts: Array<{
    content: string;
    type: string;
    source: string;
    confidence: number;
    synthesis?: string;
  }>;
  relationships: Array<{
    target: string;
    type: string;
    weight: number;
    direction: string;
  }>;
  temporalTrace: {
    firstIngested: number;
    lastAccessed: number;
    accessCount: number;
    confidenceTrend: 'stable' | 'rising' | 'decaying';
  };
}

export interface ContradictionReport {
  entityA: string;
  entityB: string;
  contentA: string;
  contentB: string;
  sharedEntities: string[];
  detectedAt: number;
}

export interface DiscoveryReport {
  contentA: string;
  contentB: string;
  sourceA: string;
  sourceB: string;
  bridgeEntities: string[];
  surprise: number;
}

export interface HealthReport {
  totalNodes: number;
  totalDirectedEdges: number;
  totalUndirectedEdges: number;
  orphanNodes: number;
  lowConfidenceNodes: number;
  expiredNodes: number;
  enrichedNodes: number;
  unenrichedNodes: number;
  nodesByType: Record<string, number>;
  edgesByType: Record<string, number>;
  avgConfidence: number;
  avgAccessCount: number;
  coverageGaps: string[]; // Entities mentioned but with sparse coverage
}

// Generate a full audit report from the graph
export function generateAuditReport(
  graph: KnowledgeGraph,
  tfidfIndex?: TfidfIndex
): AuditReport {
  const entities = generateEntityReports(graph);
  const { contradictions, discoveries } = tfidfIndex
    ? generateReflectionReports(graph, tfidfIndex)
    : { contradictions: [], discoveries: [] };
  const health = generateHealthReport(graph);

  return {
    entities,
    contradictions,
    discoveries,
    health,
    generatedAt: Date.now(),
  };
}

function generateEntityReports(graph: KnowledgeGraph): EntityReport[] {
  // Group nodes by their most prominent entity
  const entityNodes = new Map<string, Array<{ nodeId: NodeId; node: GraphNode }>>();

  for (const [nodeId, node] of graph.nodes) {
    if (node.type === 'document' || node.type === 'section') continue;
    for (const entity of node.entities) {
      const list = entityNodes.get(entity) || [];
      list.push({ nodeId, node });
      entityNodes.set(entity, list);
    }
  }

  // Generate reports for entities mentioned 3+ times
  const reports: EntityReport[] = [];

  for (const [entityName, mentions] of entityNodes) {
    if (mentions.length < 3) continue;

    const sources = [...new Set(mentions.map(m => m.node.source.file))];
    const relatedPersons: string[] = [];

    // Find related person nodes
    for (const { nodeId } of mentions) {
      for (const edge of graph.directedEdges.values()) {
        if (edge.from === nodeId || edge.to === nodeId) {
          const otherId = edge.from === nodeId ? edge.to : edge.from;
          const otherNode = graph.nodes.get(otherId);
          if (otherNode?.type === 'person') {
            relatedPersons.push(otherNode.content);
          }
        }
      }
    }

    // Collect facts
    const facts = mentions.slice(0, 20).map(({ node }) => ({
      content: node.content.slice(0, 300),
      type: node.type,
      source: node.source.file,
      confidence: node.confidence,
      synthesis: node.metadata.synthesis as string | undefined,
    }));

    // Collect relationships
    const relationships: EntityReport['relationships'] = [];
    for (const { nodeId } of mentions.slice(0, 5)) {
      for (const edge of graph.directedEdges.values()) {
        if (edge.from === nodeId) {
          const target = graph.nodes.get(edge.to);
          if (target && target.type !== 'section' && target.type !== 'document') {
            relationships.push({
              target: target.content.slice(0, 80),
              type: edge.type,
              weight: edge.weight,
              direction: 'outgoing',
            });
          }
        }
      }
    }

    // Temporal trace
    const allCreatedAt = mentions.map(m => m.node.createdAt).filter(Boolean);
    const allAccessedAt = mentions.map(m => m.node.lastAccessedAt).filter(Boolean);
    const allAccessCounts = mentions.map(m => m.node.accessCount);
    const avgConfidence = mentions.reduce((s, m) => s + m.node.confidence, 0) / mentions.length;

    reports.push({
      name: entityName,
      nodeId: mentions[0].node.type === 'person' ? mentions[0].nodeId : undefined,
      factCount: mentions.length,
      sources,
      relatedPersons: [...new Set(relatedPersons)],
      facts,
      relationships: relationships.slice(0, 10),
      temporalTrace: {
        firstIngested: Math.min(...allCreatedAt, Date.now()),
        lastAccessed: Math.max(...allAccessedAt, 0),
        accessCount: allAccessCounts.reduce((a, b) => a + b, 0),
        confidenceTrend: avgConfidence > 0.8 ? 'stable' : avgConfidence > 0.5 ? 'rising' : 'decaying',
      },
    });
  }

  // Sort by fact count
  reports.sort((a, b) => b.factCount - a.factCount);
  return reports.slice(0, 100);
}

function generateReflectionReports(
  graph: KnowledgeGraph,
  tfidfIndex: TfidfIndex
): { contradictions: ContradictionReport[]; discoveries: DiscoveryReport[] } {
  const result = reflect(graph, tfidfIndex);

  const contradictions = result.contradictions.map(c => {
    const nodeA = graph.nodes.get(c.nodeA);
    const nodeB = graph.nodes.get(c.nodeB);
    return {
      entityA: nodeA?.content.slice(0, 200) || 'Unknown',
      entityB: nodeB?.content.slice(0, 200) || 'Unknown',
      contentA: nodeA?.content || '',
      contentB: nodeB?.content || '',
      sharedEntities: c.sharedEntities,
      detectedAt: c.detectedAt,
    };
  });

  const discoveries = result.discoveries.map(d => {
    const nodeA = graph.nodes.get(d.nodeA);
    const nodeB = graph.nodes.get(d.nodeB);
    return {
      contentA: nodeA?.content.slice(0, 200) || 'Unknown',
      contentB: nodeB?.content.slice(0, 200) || 'Unknown',
      sourceA: nodeA?.source.file || '',
      sourceB: nodeB?.source.file || '',
      bridgeEntities: d.bridgeEntities,
      surprise: d.surprise,
    };
  });

  return { contradictions, discoveries };
}

function generateHealthReport(graph: KnowledgeGraph): HealthReport {
  const now = Date.now();
  let orphanNodes = 0;
  let lowConfidenceNodes = 0;
  let expiredNodes = 0;
  let enrichedNodes = 0;
  let unenrichedNodes = 0;
  let totalConfidence = 0;
  let totalAccessCount = 0;
  const nodesByType: Record<string, number> = {};
  const edgesByType: Record<string, number> = {};
  const entityCoverage = new Map<string, number>();

  // Connected nodes set
  const connected = new Set<NodeId>();
  for (const edge of graph.directedEdges.values()) {
    connected.add(edge.from);
    connected.add(edge.to);
    edgesByType[edge.type] = (edgesByType[edge.type] || 0) + 1;
  }
  for (const edge of graph.undirectedEdges.values()) {
    connected.add(edge.nodes[0]);
    connected.add(edge.nodes[1]);
    edgesByType[edge.type] = (edgesByType[edge.type] || 0) + 1;
  }

  for (const [nodeId, node] of graph.nodes) {
    nodesByType[node.type] = (nodesByType[node.type] || 0) + 1;
    totalConfidence += node.confidence;
    totalAccessCount += node.accessCount;

    if (!connected.has(nodeId)) orphanNodes++;
    if (node.confidence < 0.5) lowConfidenceNodes++;
    if (node.validUntil && now > node.validUntil) expiredNodes++;
    if (node.metadata.synthesis) enrichedNodes++;
    else if (node.type !== 'document' && node.type !== 'section') unenrichedNodes++;

    for (const entity of node.entities) {
      entityCoverage.set(entity, (entityCoverage.get(entity) || 0) + 1);
    }
  }

  // Coverage gaps: entities mentioned only once (sparse)
  const coverageGaps = Array.from(entityCoverage.entries())
    .filter(([, count]) => count === 1)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(0, 20)
    .map(([entity]) => entity);

  return {
    totalNodes: graph.nodes.size,
    totalDirectedEdges: graph.directedEdges.size,
    totalUndirectedEdges: graph.undirectedEdges.size,
    orphanNodes,
    lowConfidenceNodes,
    expiredNodes,
    enrichedNodes,
    unenrichedNodes,
    nodesByType,
    edgesByType,
    avgConfidence: graph.nodes.size > 0 ? totalConfidence / graph.nodes.size : 0,
    avgAccessCount: graph.nodes.size > 0 ? totalAccessCount / graph.nodes.size : 0,
    coverageGaps,
  };
}

// Export audit report as markdown string
export function auditToMarkdown(report: AuditReport, graphName: string): string {
  const lines: string[] = [];

  lines.push(`# Knowledge Audit — ${graphName}`);
  lines.push(`Generated: ${new Date(report.generatedAt).toISOString()}\n`);

  // Health summary
  lines.push('## Graph Health\n');
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Total Nodes | ${report.health.totalNodes.toLocaleString()} |`);
  lines.push(`| Total Edges | ${(report.health.totalDirectedEdges + report.health.totalUndirectedEdges).toLocaleString()} |`);
  lines.push(`| Avg Confidence | ${(report.health.avgConfidence * 100).toFixed(1)}% |`);
  lines.push(`| Enriched Nodes | ${report.health.enrichedNodes} / ${report.health.enrichedNodes + report.health.unenrichedNodes} |`);
  lines.push(`| Orphan Nodes | ${report.health.orphanNodes} |`);
  lines.push(`| Low Confidence (<50%) | ${report.health.lowConfidenceNodes} |`);
  lines.push(`| Expired Nodes | ${report.health.expiredNodes} |`);
  lines.push('');

  // Node type breakdown
  lines.push('### Node Types\n');
  for (const [type, count] of Object.entries(report.health.nodesByType)) {
    lines.push(`- **${type}**: ${count}`);
  }
  lines.push('');

  // Top entities
  lines.push('## Top Entities\n');
  for (const entity of report.entities.slice(0, 30)) {
    lines.push(`### ${entity.name}\n`);
    lines.push(`- **Facts:** ${entity.factCount} across ${entity.sources.length} source(s)`);
    lines.push(`- **Sources:** ${entity.sources.join(', ')}`);
    if (entity.relatedPersons.length > 0) {
      lines.push(`- **Related persons:** ${entity.relatedPersons.join(', ')}`);
    }
    lines.push(`- **Access count:** ${entity.temporalTrace.accessCount}`);
    lines.push(`- **Confidence trend:** ${entity.temporalTrace.confidenceTrend}`);

    // Top facts
    for (const fact of entity.facts.slice(0, 3)) {
      const synth = fact.synthesis ? ` _Synthesis: ${fact.synthesis}_` : '';
      lines.push(`  - [${fact.type}, ${(fact.confidence * 100).toFixed(0)}%] ${fact.content.slice(0, 150)}${synth}`);
    }
    lines.push('');
  }

  // Contradictions
  if (report.contradictions.length > 0) {
    lines.push('## Contradictions Detected\n');
    for (const c of report.contradictions) {
      lines.push(`### Shared entities: ${c.sharedEntities.join(', ')}\n`);
      lines.push(`**Claim A:** ${c.contentA.slice(0, 200)}\n`);
      lines.push(`**Claim B:** ${c.contentB.slice(0, 200)}\n`);
      lines.push(`Detected: ${new Date(c.detectedAt).toISOString()}\n`);
    }
  }

  // Discoveries
  if (report.discoveries.length > 0) {
    lines.push('## Cross-Domain Discoveries\n');
    for (const d of report.discoveries.slice(0, 10)) {
      lines.push(`- **Bridge:** ${d.bridgeEntities.join(', ')} (surprise: ${(d.surprise * 100).toFixed(0)}%)`);
      lines.push(`  - Source A: ${d.sourceA} — "${d.contentA.slice(0, 100)}"`);
      lines.push(`  - Source B: ${d.sourceB} — "${d.contentB.slice(0, 100)}"`);
    }
    lines.push('');
  }

  // Coverage gaps
  if (report.health.coverageGaps.length > 0) {
    lines.push('## Coverage Gaps\n');
    lines.push('Entities mentioned only once (may need more sources):\n');
    lines.push(report.health.coverageGaps.map(e => `\`${e}\``).join(', '));
    lines.push('');
  }

  return lines.join('\n');
}
