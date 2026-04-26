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
import { asciiFoldAnalyzer, type TextAnalyzer } from '@/core/similarity/analyzer';
import { createEmbeddingIndex, embedNodes, type EmbeddingIndex } from '@/core/similarity/embeddings';
import type { EmbeddingAdapter } from '@/core/similarity/embedding-adapter';
import { buildDirectedEdges, chunkKey } from './directed-edges';
import { buildUndirectedEdges } from './undirected-edges';
import { pruneGraph } from '@/core/optimization/pruner';

export type BuiltGraph = KnowledgeGraph & {
  tfidfIndex: ReturnType<typeof createTfidfIndex>;
  embeddingIndex?: EmbeddingIndex;
};

export function buildGraph(
  documents: ParsedDocument[],
  graphName: string,
  analyzer: TextAnalyzer = asciiFoldAnalyzer
): BuiltGraph {
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
  const tfidfIndex = createTfidfIndex(analyzer);
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
  const rawUndirectedEdges = buildUndirectedEdges(allChunks, tfidfIndex, chunkKeyToNodeId, analyzer);
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
      analyzerAdapterId: analyzer.id,
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
    console.log(`[graphnosis] Pruned ${prunedNodes} orphan nodes, ${prunedEdges} low-weight edges`);
  }

  return { ...graph, tfidfIndex } as BuiltGraph;
}

// Async pass: embed every content chunk and attach an EmbeddingIndex.
// Kept separate from buildGraph so the sync ingestion path stays sync for
// every existing caller (Chat / Giki / examples / app routes). Only the
// LongMemEval runner opts into this for now.
export async function attachEmbeddings(
  graph: BuiltGraph,
  adapter: EmbeddingAdapter,
  opts: {
    batchSize?: number;
    onProgress?: (info: { done: number; total: number }) => void;
    signal?: AbortSignal;
  } = {}
): Promise<BuiltGraph> {
  const items: Array<{ nodeId: NodeId; text: string }> = [];
  for (const node of graph.nodes.values()) {
    // Skip structural nodes; they're filtered from the serialized prompt anyway
    // and embedding them would waste budget.
    if (node.type === 'document' || node.type === 'section') continue;
    if (!node.content || !node.content.trim()) continue;
    items.push({ nodeId: node.id, text: node.content });
  }
  if (items.length === 0) return graph;

  const index = createEmbeddingIndex(adapter);
  await embedNodes(index, adapter, items, {
    intent: 'document',
    batchSize: opts.batchSize,
    onProgress: opts.onProgress,
    signal: opts.signal,
  });
  graph.embeddingIndex = index;
  return graph;
}

function simpleHash(text: string): string {
  // Simple DJB2 hash for deduplication — fast, not cryptographic
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) & 0xffffffff;
  }
  return hash.toString(36);
}
