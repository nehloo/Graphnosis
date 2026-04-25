import { nanoid } from 'nanoid';
import type {
  KnowledgeGraph,
  ParsedDocument,
  TfidfIndex,
  NodeId,
} from '@/core/types';
import { chunkDocument } from '@/core/extraction/chunker';
import { createTfidfIndex, addDocument, computeIdf } from '@/core/similarity/tfidf';
import { buildDirectedEdges, chunkKey } from './directed-edges';
import { buildUndirectedEdges } from './undirected-edges';

export interface IncrementalResult {
  newNodes: number;
  newDirectedEdges: number;
  newUndirectedEdges: number;
  /** IDs of the newly added nodes — used by callers to scope contradiction detection */
  newNodeIds: NodeId[];
}

// Add new documents to an existing graph without full rebuild
export function addDocumentsToGraph(
  graph: KnowledgeGraph & { tfidfIndex?: TfidfIndex },
  newDocuments: ParsedDocument[]
): IncrementalResult {
  const startNodeCount = graph.nodes.size;
  const startDirectedCount = graph.directedEdges.size;
  const startUndirectedCount = graph.undirectedEdges.size;

  // Step 1: Chunk new documents
  const allNewChunks = newDocuments.flatMap(doc => chunkDocument(doc));

  // Step 2: Create nodes from new chunks (check for duplicates by content hash)
  const existingHashes = new Set<string>();
  for (const node of graph.nodes.values()) {
    existingHashes.add(node.contentHash);
  }

  const newChunkKeyToNodeId = new Map<string, string>();
  const newNodeIds: NodeId[] = [];

  for (const chunk of allNewChunks) {
    const hash = simpleHash(chunk.content);
    if (existingHashes.has(hash)) continue; // Skip duplicates

    const nodeId = nanoid();
    const key = chunkKey(chunk);
    newChunkKeyToNodeId.set(key, nodeId);
    newNodeIds.push(nodeId);

    graph.nodes.set(nodeId, {
      id: nodeId,
      content: chunk.content,
      contentHash: hash,
      type: chunk.type,
      source: chunk.source,
      entities: chunk.entities,
      metadata: chunk.metadata,
      level: 0,
      confidence: 0.9,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      accessCount: 0,
    });
  }

  if (newChunkKeyToNodeId.size === 0) {
    return { newNodes: 0, newDirectedEdges: 0, newUndirectedEdges: 0, newNodeIds: [] };
  }

  // Step 3: Build TF-IDF index for new nodes
  const tfidfIndex = graph.tfidfIndex || createTfidfIndex();

  for (const chunk of allNewChunks) {
    const key = chunkKey(chunk);
    const nodeId = newChunkKeyToNodeId.get(key);
    if (nodeId && chunk.type !== 'document' && chunk.type !== 'section') {
      addDocument(tfidfIndex, nodeId, chunk.content);
    }
  }
  computeIdf(tfidfIndex);
  graph.tfidfIndex = tfidfIndex;

  // Step 4: Build directed edges for new chunks only
  const rawDirectedEdges = buildDirectedEdges(allNewChunks);
  for (const edge of rawDirectedEdges) {
    const fromId = newChunkKeyToNodeId.get(edge.from);
    const toId = newChunkKeyToNodeId.get(edge.to);
    if (fromId && toId) {
      graph.directedEdges.set(edge.id, { ...edge, from: fromId, to: toId });
    }
  }

  // Step 5: Build undirected edges between new nodes and existing nodes
  const rawUndirectedEdges = buildUndirectedEdges(allNewChunks, tfidfIndex, newChunkKeyToNodeId);
  for (const edge of rawUndirectedEdges) {
    graph.undirectedEdges.set(edge.id, edge);
  }

  // Step 6: Update metadata
  const newSourceFiles = [...new Set(newDocuments.map(d => d.sourceFile))];
  graph.metadata.sourceFiles.push(...newSourceFiles);
  graph.metadata.nodeCount = graph.nodes.size;
  graph.metadata.directedEdgeCount = graph.directedEdges.size;
  graph.metadata.undirectedEdgeCount = graph.undirectedEdges.size;
  graph.metadata.updatedAt = Date.now();
  graph.metadata.version++;

  return {
    newNodes: graph.nodes.size - startNodeCount,
    newDirectedEdges: graph.directedEdges.size - startDirectedCount,
    newUndirectedEdges: graph.undirectedEdges.size - startUndirectedCount,
    newNodeIds,
  };
}

function simpleHash(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) & 0xffffffff;
  }
  return hash.toString(36);
}
