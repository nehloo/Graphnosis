import { nanoid } from 'nanoid';
import type {
  KnowledgeGraph,
  GraphNode,
  DirectedEdge,
  NodeId,
  NodeType,
  ExtractedChunk,
} from '@/core/types';
import { chunkDocument } from '@/core/extraction/chunker';
import { parseMarkdown } from '@/core/ingestion/parsers/markdown-parser';
import { addDocument, computeIdf } from '@/core/similarity/tfidf';
import type { TfidfIndex } from '@/core/types';
import { buildDirectedEdges, chunkKey } from '@/core/graph/directed-edges';
import { extractEntities } from '@/core/extraction/entity-extractor';

// Human correction types
export interface Correction {
  type: 'edit' | 'add' | 'delete' | 'supersede';
  nodeId?: NodeId; // For edit/delete/supersede — which node to modify
  content?: string; // New content (for edit/add)
  reason: string; // Why this correction was made
  timestamp: number;
}

export interface CorrectionResult {
  applied: number;
  nodesAdded: number;
  nodesModified: number;
  nodesSuperseded: number;
  errors: string[];
}

// Apply a single correction to the graph
export function applyCorrection(
  graph: KnowledgeGraph,
  tfidfIndex: TfidfIndex,
  correction: Correction
): { success: boolean; error?: string; affectedNodeId?: NodeId } {
  switch (correction.type) {
    case 'edit':
      return applyEdit(graph, tfidfIndex, correction);
    case 'add':
      return applyAdd(graph, tfidfIndex, correction);
    case 'delete':
      return applyDelete(graph, correction);
    case 'supersede':
      return applySupersede(graph, tfidfIndex, correction);
    default:
      return { success: false, error: `Unknown correction type: ${correction.type}` };
  }
}

// Edit an existing node's content
function applyEdit(
  graph: KnowledgeGraph,
  tfidfIndex: TfidfIndex,
  correction: Correction
): { success: boolean; error?: string; affectedNodeId?: NodeId } {
  if (!correction.nodeId || !correction.content) {
    return { success: false, error: 'Edit requires nodeId and content' };
  }

  const node = graph.nodes.get(correction.nodeId);
  if (!node) {
    return { success: false, error: `Node ${correction.nodeId} not found` };
  }

  // Update node content
  node.content = correction.content;
  node.contentHash = simpleHash(correction.content);
  node.metadata.correctedAt = correction.timestamp;
  node.metadata.correctionReason = correction.reason;
  node.confidence = 1.0; // Human-corrected = max confidence
  node.lastAccessedAt = Date.now();

  node.entities = extractEntities(correction.content);

  // Update TF-IDF index
  addDocument(tfidfIndex, correction.nodeId, correction.content);
  computeIdf(tfidfIndex);

  graph.metadata.updatedAt = Date.now();
  graph.metadata.version++;

  return { success: true, affectedNodeId: correction.nodeId };
}

// Add a new fact/correction as a new node
function applyAdd(
  graph: KnowledgeGraph,
  tfidfIndex: TfidfIndex,
  correction: Correction
): { success: boolean; error?: string; affectedNodeId?: NodeId } {
  if (!correction.content) {
    return { success: false, error: 'Add requires content' };
  }

  const nodeId = nanoid();

  const newNode: GraphNode = {
    id: nodeId,
    content: correction.content,
    contentHash: simpleHash(correction.content),
    type: classifyCorrectionType(correction.content),
    source: { file: 'human-correction', offset: 0 },
    entities: extractEntities(correction.content),
    metadata: {
      correctedAt: correction.timestamp,
      correctionReason: correction.reason,
      source: 'human',
    },
    level: 0,
    confidence: 1.0, // Human-provided = max confidence
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
    accessCount: 0,
  };

  graph.nodes.set(nodeId, newNode);

  // Add to TF-IDF index
  addDocument(tfidfIndex, nodeId, correction.content);
  computeIdf(tfidfIndex);

  // If this correction relates to an existing node, create an edge
  if (correction.nodeId) {
    const edge: DirectedEdge = {
      id: nanoid(),
      from: correction.nodeId,
      to: nodeId,
      type: 'supports',
      weight: 0.9,
      evidence: `Human correction: ${correction.reason}`,
      createdAt: Date.now(),
    };
    graph.directedEdges.set(edge.id, edge);
    graph.metadata.directedEdgeCount = graph.directedEdges.size;
  }

  graph.metadata.nodeCount = graph.nodes.size;
  graph.metadata.updatedAt = Date.now();
  graph.metadata.version++;

  return { success: true, affectedNodeId: nodeId };
}

// Soft-delete: mark a node as expired, don't remove it
function applyDelete(
  graph: KnowledgeGraph,
  correction: Correction
): { success: boolean; error?: string; affectedNodeId?: NodeId } {
  if (!correction.nodeId) {
    return { success: false, error: 'Delete requires nodeId' };
  }

  const node = graph.nodes.get(correction.nodeId);
  if (!node) {
    return { success: false, error: `Node ${correction.nodeId} not found` };
  }

  // Soft delete: set validUntil to now, reduce confidence
  node.validUntil = Date.now();
  node.confidence = 0.1;
  node.metadata.deletedAt = Date.now();
  node.metadata.deleteReason = correction.reason;

  graph.metadata.updatedAt = Date.now();
  graph.metadata.version++;

  return { success: true, affectedNodeId: correction.nodeId };
}

// Supersede: add new content that replaces an old node
function applySupersede(
  graph: KnowledgeGraph,
  tfidfIndex: TfidfIndex,
  correction: Correction
): { success: boolean; error?: string; affectedNodeId?: NodeId } {
  if (!correction.nodeId || !correction.content) {
    return { success: false, error: 'Supersede requires nodeId and content' };
  }

  const oldNode = graph.nodes.get(correction.nodeId);
  if (!oldNode) {
    return { success: false, error: `Node ${correction.nodeId} not found` };
  }

  // Create new node with corrected content
  const addResult = applyAdd(graph, tfidfIndex, {
    ...correction,
    type: 'add',
    nodeId: undefined, // Don't link as support, we'll create supersedes edge
  });

  if (!addResult.success || !addResult.affectedNodeId) {
    return addResult;
  }

  // Create supersedes edge: old → new
  const edge: DirectedEdge = {
    id: nanoid(),
    from: correction.nodeId,
    to: addResult.affectedNodeId,
    type: 'supersedes',
    weight: 1.0,
    evidence: `Human correction: ${correction.reason}`,
    createdAt: Date.now(),
  };
  graph.directedEdges.set(edge.id, edge);

  // Reduce old node's confidence
  oldNode.confidence = Math.min(oldNode.confidence, 0.3);
  oldNode.validUntil = Date.now();

  graph.metadata.directedEdgeCount = graph.directedEdges.size;
  graph.metadata.updatedAt = Date.now();

  return { success: true, affectedNodeId: addResult.affectedNodeId };
}

// Bulk import: accept a markdown document of corrections/facts
export function importCorrections(
  graph: KnowledgeGraph,
  tfidfIndex: TfidfIndex,
  markdownContent: string,
  sourceLabel: string
): CorrectionResult {
  const result: CorrectionResult = {
    applied: 0,
    nodesAdded: 0,
    nodesModified: 0,
    nodesSuperseded: 0,
    errors: [],
  };

  // Parse the markdown into a document
  const doc = parseMarkdown(markdownContent, `correction:${sourceLabel}`);
  const chunks = chunkDocument(doc);

  for (const chunk of chunks) {
    if (chunk.type === 'document' || chunk.type === 'section') continue;
    if (chunk.content.length < 20) continue;

    const addResult = applyAdd(graph, tfidfIndex, {
      type: 'add',
      content: chunk.content,
      reason: `Imported from: ${sourceLabel}`,
      timestamp: Date.now(),
    });

    if (addResult.success) {
      result.applied++;
      result.nodesAdded++;
    } else {
      result.errors.push(addResult.error || 'Unknown error');
    }
  }

  return result;
}

// Bulk forgetting: soft-delete nodes by time window
export function forgetByTimeWindow(
  graph: KnowledgeGraph,
  before: number, // Timestamp: forget everything created before this
  reason: string = 'Bulk time-window forgetting'
): { forgotten: number } {
  let forgotten = 0;
  const now = Date.now();

  for (const [, node] of graph.nodes) {
    if (node.type === 'document' || node.type === 'section') continue;
    if (node.validUntil && node.validUntil < now) continue; // Already forgotten
    if (node.createdAt < before) {
      node.validUntil = now;
      node.confidence = 0.1;
      node.metadata.forgottenAt = now;
      node.metadata.forgetReason = reason;
      forgotten++;
    }
  }

  graph.metadata.updatedAt = now;
  graph.metadata.version++;
  return { forgotten };
}

// Bulk forgetting: soft-delete nodes by topic (entity match)
export function forgetByTopic(
  graph: KnowledgeGraph,
  topic: string,
  reason: string = `Bulk topic forgetting: ${topic}`
): { forgotten: number } {
  let forgotten = 0;
  const now = Date.now();
  const topicLower = topic.toLowerCase();

  for (const [, node] of graph.nodes) {
    if (node.type === 'document' || node.type === 'section') continue;
    if (node.validUntil && node.validUntil < now) continue; // Already forgotten

    const matchesEntity = node.entities.some(e => e.toLowerCase().includes(topicLower));
    const matchesContent = node.content.toLowerCase().includes(topicLower);

    if (matchesEntity || matchesContent) {
      node.validUntil = now;
      node.confidence = 0.1;
      node.metadata.forgottenAt = now;
      node.metadata.forgetReason = reason;
      forgotten++;
    }
  }

  graph.metadata.updatedAt = now;
  graph.metadata.version++;
  return { forgotten };
}

// Cascade soft-delete: when a source node is soft-deleted,
// follow edges to soft-delete all downstream nodes from that source
export function cascadeSoftDelete(
  graph: KnowledgeGraph,
  nodeId: NodeId,
  reason: string = 'Cascade from parent soft-delete'
): { cascaded: number } {
  const now = Date.now();
  const visited = new Set<NodeId>();
  const queue = [nodeId];
  let cascaded = 0;

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);

    const node = graph.nodes.get(current);
    if (!node) continue;

    // Soft-delete this node (skip if already expired)
    if (!node.validUntil || node.validUntil > now) {
      node.validUntil = now;
      node.confidence = Math.min(node.confidence, 0.1);
      node.metadata.forgottenAt = now;
      node.metadata.forgetReason = reason;
      if (current !== nodeId) cascaded++; // Don't count the root node
    }

    // Follow outgoing "contains" edges to find children
    for (const edge of graph.directedEdges.values()) {
      if (edge.from === current && edge.type === 'contains') {
        queue.push(edge.to);
      }
    }

    // Follow nodes from the same source file
    if (current === nodeId && node.source.file) {
      for (const [otherId, otherNode] of graph.nodes) {
        if (otherId === nodeId) continue;
        if (otherNode.source.file === node.source.file) {
          queue.push(otherId);
        }
      }
    }
  }

  graph.metadata.updatedAt = now;
  graph.metadata.version++;
  return { cascaded };
}

function classifyCorrectionType(text: string): NodeType {
  const lower = text.toLowerCase();
  if (/\b(is defined as|refers to|means)\b/.test(lower)) return 'definition';
  if (/\b(in \d{4}|founded|invented|created)\b/.test(lower)) return 'event';
  if (/\b(should|must|prefer|always|never)\b/.test(lower)) return 'preference' as NodeType;
  return 'fact';
}

function simpleHash(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) & 0xffffffff;
  }
  return hash.toString(36);
}
