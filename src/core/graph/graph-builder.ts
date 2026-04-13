import { nanoid } from 'nanoid';
import type {
  KnowledgeGraph,
  GraphNode,
  ExtractedChunk,
  ParsedDocument,
  NodeId,
} from '@/core/types';
import { chunkDocument } from '@/core/extraction/chunker';
import { createTfidfIndex, addDocument, computeIdf } from '@/core/similarity/tfidf';
import { buildDirectedEdges, chunkKey } from './directed-edges';
import { buildUndirectedEdges } from './undirected-edges';
import { pruneGraph } from '@/core/optimization/pruner';

export function buildGraph(documents: ParsedDocument[], graphName: string): KnowledgeGraph {
  // Step 1: Chunk all documents
  const allChunks: ExtractedChunk[] = [];
  for (const doc of documents) {
    const chunks = chunkDocument(doc);
    allChunks.push(...chunks);
  }

  // Step 2: Create nodes from chunks
  const nodes = new Map<NodeId, GraphNode>();
  const chunkKeyToNodeId = new Map<string, NodeId>();

  for (const chunk of allChunks) {
    const nodeId = nanoid();
    const key = chunkKey(chunk);
    chunkKeyToNodeId.set(key, nodeId);

    nodes.set(nodeId, {
      id: nodeId,
      content: chunk.content,
      contentHash: simpleHash(chunk.content),
      type: chunk.type,
      source: chunk.source,
      entities: chunk.entities,
      metadata: chunk.metadata,
      level: 0,
      confidence: 0.9, // Default confidence for extracted content
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      accessCount: 0,
    });
  }

  // Step 3: Build TF-IDF index for similarity computation
  const tfidfIndex = createTfidfIndex();
  for (const chunk of allChunks) {
    const key = chunkKey(chunk);
    const nodeId = chunkKeyToNodeId.get(key);
    if (nodeId && chunk.type !== 'document' && chunk.type !== 'section') {
      addDocument(tfidfIndex, nodeId, chunk.content);
    }
  }
  computeIdf(tfidfIndex);

  // Step 4: Build directed edges
  const rawDirectedEdges = buildDirectedEdges(allChunks);

  // Remap chunk keys to node IDs in directed edges
  const directedEdges = new Map();
  for (const edge of rawDirectedEdges) {
    const fromId = chunkKeyToNodeId.get(edge.from);
    const toId = chunkKeyToNodeId.get(edge.to);
    if (fromId && toId) {
      const remapped = { ...edge, from: fromId, to: toId };
      directedEdges.set(edge.id, remapped);
    }
  }

  // Step 5: Build undirected edges (using TF-IDF similarity)
  const rawUndirectedEdges = buildUndirectedEdges(allChunks, tfidfIndex, chunkKeyToNodeId);
  const undirectedEdges = new Map();
  for (const edge of rawUndirectedEdges) {
    undirectedEdges.set(edge.id, edge);
  }

  // Step 6: Assemble the graph
  const sourceFiles = [...new Set(documents.map(d => d.sourceFile))];

  const graph: KnowledgeGraph = {
    id: nanoid(),
    name: graphName,
    nodes,
    directedEdges,
    undirectedEdges,
    levels: 1,
    metadata: {
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sourceFiles,
      nodeCount: nodes.size,
      directedEdgeCount: directedEdges.size,
      undirectedEdgeCount: undirectedEdges.size,
      version: 1,
    },
  };

  // Step 7: Auto-prune orphan nodes and low-weight edges
  // Skip pruning for small graphs (test documents, small datasets)
  const shouldPrune = graph.nodes.size > 50;
  const { prunedEdges, prunedNodes } = shouldPrune
    ? pruneGraph(graph, {
        minDirectedWeight: 0.05,
        minUndirectedWeight: 0.1,
        removeOrphans: true,
      })
    : { prunedEdges: 0, prunedNodes: 0 };

  if (prunedNodes > 0 || prunedEdges > 0) {
    console.log(`[graphAI] Pruned ${prunedNodes} orphan nodes, ${prunedEdges} low-weight edges`);
  }

  return { ...graph, tfidfIndex } as KnowledgeGraph & { tfidfIndex: typeof tfidfIndex };
}

function simpleHash(text: string): string {
  // Simple DJB2 hash for deduplication — fast, not cryptographic
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) & 0xffffffff;
  }
  return hash.toString(36);
}
