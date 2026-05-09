// Graphnosis Core Type Definitions
// All TypeScript interfaces that define the dual-graph knowledge model

export type NodeId = string;
export type EdgeId = string;

// --- Node Types ---

export type NodeType =
  | 'fact'
  | 'concept'
  | 'entity'
  | 'event'
  | 'definition'
  | 'claim'
  | 'data-point'
  | 'section'
  | 'document'
  // Identity types (Step 3)
  | 'person'
  | 'organization'
  | 'preference'
  // Conversation types (Step 2)
  | 'conversation'
  | 'message'
  // Multimodal types
  | 'image'
  | 'video'
  | 'transcript'
  | 'visual-description'
  // LongMemEval Phase 2: per-session compressed summary node.
  // Created by session-summarizer from the full turn list of a session,
  // linked back to each turn via a 'summarizes' directed edge.
  | 'session-summary';

export interface SourceReference {
  file: string;
  offset: number;
  line?: number;
  section?: string;
}

export interface GraphNode {
  id: NodeId;
  content: string;
  contentHash: string;
  type: NodeType;
  source: SourceReference;
  entities: string[];
  metadata: Record<string, string | number>;
  level: number; // Hierarchy level (0 = leaf, 1+ = summary)
  confidence: number; // 0-1, extraction confidence
  // Temporal fields (Step 1)
  createdAt: number; // Timestamp of node creation
  lastAccessedAt: number; // Last time this node was retrieved in a query
  accessCount: number; // How many times retrieved
  validUntil?: number; // If set, node is considered expired after this timestamp
}

// --- Edge Types ---

export type DirectedEdgeType =
  | 'causes'
  | 'depends-on'
  | 'precedes'
  | 'contains'
  | 'defines'
  | 'cites'
  | 'contradicts'
  | 'supports'
  // Temporal & identity edges
  | 'supersedes' // New info replaces old (old → new)
  | 'discussed-in' // Knowledge node → conversation it came from
  | 'knows' // Person → person
  | 'works-with' // Person → person (professional)
  | 'reports-to' // Person → person (hierarchy)
  | 'collaborated-on' // Person → document/concept
  | 'prefers' // User → concept/preference
  // LongMemEval Phase 2: session-summary → turn. Lets BFS reach the
  // session's turn nodes from a summary seed (and be blocked by the
  // router on single-session-user/assistant categories).
  | 'summarizes';

export type UndirectedEdgeType =
  | 'similar-to'
  | 'co-occurs'
  | 'shares-entity'
  | 'shares-topic'
  | 'same-source'
  // Identity edges
  | 'same-person' // Two mentions of the same person across sources
  | 'related-to'; // General relationship between people/concepts

export interface DirectedEdge {
  id: EdgeId;
  from: NodeId;
  to: NodeId;
  type: DirectedEdgeType;
  weight: number; // 0-1
  evidence?: string;
  createdAt?: number;
}

export interface UndirectedEdge {
  id: EdgeId;
  nodes: [NodeId, NodeId];
  type: UndirectedEdgeType;
  weight: number; // 0-1
  createdAt?: number;
}

// --- Graph ---

export interface GraphMetadata {
  createdAt: number;
  updatedAt: number;
  sourceFiles: string[];
  nodeCount: number;
  directedEdgeCount: number;
  undirectedEdgeCount: number;
  version: number;
  conversationCount?: number;
  personCount?: number;
  /**
   * Analyzer id this graph was tokenized with. Always populated on
   * v0.2+ saves. Persisted so `loadGai` / `loadSqlite*` / `fromBuffer`
   * fail closed with `AnalyzerMismatchError` when the runtime is
   * configured with a different analyzer.
   */
  analyzerAdapterId?: string;
  /**
   * Embedding adapter id, if `buildEmbeddings()` ran. NOT persisted in
   * v0.2 (the embedding vectors themselves aren't serialized either) but
   * the field is reserved for future use when `.gai` / SQLite gain vector
   * persistence.
   */
  embeddingAdapterId?: string;
}

export interface KnowledgeGraph {
  id: string;
  name: string;
  nodes: Map<NodeId, GraphNode>;
  directedEdges: Map<EdgeId, DirectedEdge>;
  undirectedEdges: Map<EdgeId, UndirectedEdge>;
  levels: number;
  metadata: GraphMetadata;
}

// --- Serializable versions (for .gai format and JSON transport) ---

export interface SerializableGraph {
  id: string;
  name: string;
  nodes: Array<GraphNode>;
  directedEdges: Array<DirectedEdge>;
  undirectedEdges: Array<UndirectedEdge>;
  levels: number;
  metadata: GraphMetadata;
}

// --- Pipeline Types ---

export type PipelineStage =
  | 'ingestion'
  | 'extraction'
  | 'graph-construction'
  | 'optimization'
  | 'serialization';

export interface PipelineEvent {
  stage: PipelineStage;
  progress: number; // 0-100
  message: string;
  timestamp: number;
}

export interface ParsedDocument {
  title: string;
  sections: ParsedSection[];
  sourceFile: string;
  metadata: Record<string, string | number>;
}

export interface ParsedSection {
  title: string;
  content: string;
  depth: number;
  children: ParsedSection[];
}

// --- Extraction Types ---

export interface ExtractedChunk {
  content: string;
  type: NodeType;
  source: SourceReference;
  entities: string[];
  metadata: Record<string, string | number>;
  parentId?: string; // For hierarchy
  order: number; // Sequential order within parent
  links: string[]; // Internal references/links found in the chunk
}

// --- Query Types ---

export interface QueryResult {
  answer: string;
  subgraph: SubgraphContext;
  seeds: Array<{ nodeId: NodeId; score: number }>;
}

export interface SubgraphContext {
  nodes: GraphNode[];
  directedEdges: DirectedEdge[];
  undirectedEdges: UndirectedEdge[];
  serialized: string; // The prompt-ready text format
}

// --- Index Provenance (shared by TfidfIndex + EmbeddingIndex) ---

/**
 * Stable metadata about how an index was built. Lets the SDK warn at load
 * time when an index is loaded against an incompatible runtime config
 * (different analyzer, different embedding adapter / dimensions / intent).
 */
export interface IndexProvenance {
  /**
   * Stable identifier for the analyzer / adapter. Two indexes with the
   * same `adapterId` MUST produce values in the same space.
   *
   * For TfidfIndex: an analyzer id like 'english' or 'unicode'.
   * For EmbeddingIndex: an adapter id encoding model + dim + intent, e.g.
   * 'openai:text-embedding-3-small@1536' or
   * 'voyage:voyage-3-large@1024:document'.
   */
  adapterId: string;
  /** Wall-clock ms when the index was first populated. */
  createdAt: number;
  /**
   * Staleness fingerprint — NOT a security primitive.
   *
   * Cheap FNV-1a over sorted nodeIds + content lengths. Lets `g.stats()`
   * and the audit exporter detect "index is stale relative to the graph"
   * without re-scanning content.
   *
   * The .gai HMAC trailer is the integrity boundary; this field is for
   * cheap drift detection only. Two indexes with identical `checksum`
   * are very likely identical, but this is NOT cryptographically
   * guaranteed and MUST NOT be used as a tamper-evidence signal.
   */
  checksum?: string;
}

// --- TF-IDF Types ---

export interface TfidfIndex {
  documents: Map<NodeId, Map<string, number>>; // nodeId -> term -> tfidf weight
  idf: Map<string, number>; // term -> idf value
  documentCount: number;
  /**
   * Provenance. Optional for backwards compatibility with v0.1 .gai files;
   * defaults to `{ adapterId: 'english', createdAt: 0 }` on load when
   * missing. v0.2+ always populates this.
   */
  provenance?: IndexProvenance;
}

// --- Conversation Types (Step 2) ---

export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: number;
}

export interface ParsedConversation {
  id: string;
  title: string;
  messages: ConversationMessage[];
  sourceFile: string;
  startedAt: number;
  format: 'claude' | 'chatgpt' | 'slack' | 'raw';
  metadata: Record<string, string | number>;
}

// --- Identity Types (Step 3) ---

export interface PersonProfile {
  nodeId: NodeId;
  name: string;
  aliases: string[]; // Alternative names/handles
  attributes: Record<string, string>; // role, company, email, etc.
  firstMentionedAt: number;
  lastMentionedAt: number;
  mentionCount: number;
}

export interface UserProfile {
  nodeId: NodeId;
  preferences: Map<string, number>; // concept → affinity score
  communicationStyle: {
    prefersBullets: boolean;
    prefersDetail: 'concise' | 'detailed' | 'unknown';
    technicalDepth: 'beginner' | 'intermediate' | 'expert' | 'unknown';
  };
  domains: string[]; // Topics the user frequently asks about
  inferredAt: number;
}

// --- Reflection Types (Step 5) ---

export interface Contradiction {
  nodeA: NodeId;
  nodeB: NodeId;
  sharedEntities: string[];
  description: string;
  detectedAt: number;
  resolved: boolean;
}

export interface ConnectionDiscovery {
  nodeA: NodeId;
  nodeB: NodeId;
  bridgeEntities: string[];
  surprise: number; // 0-1, how unexpected this connection is
  discoveredAt: number;
}

// --- Router category ---
// Originally defined in the LongMemEval test dataset module, hoisted here so
// src/core/* has no upward dependencies on test or app code. The dataset
// module re-exports this for backwards compatibility.
export type LMEQuestionType =
  | 'single-session-user'
  | 'single-session-assistant'
  | 'single-session-preference'
  | 'multi-session'
  | 'temporal-reasoning'
  | 'knowledge-update';
