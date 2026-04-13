// Bignosis Constants

// .gai file format magic bytes: "GAI" + version 1
export const GAI_MAGIC = new Uint8Array([0x47, 0x41, 0x49, 0x01]);
export const GAI_VERSION = 1;

// Similarity thresholds
export const SIMILARITY_THRESHOLD = 0.3; // Minimum cosine similarity for undirected edges
export const DEDUP_THRESHOLD = 0.95; // Near-duplicate detection threshold
export const ENTITY_JACCARD_THRESHOLD = 0.2; // Minimum Jaccard for shares-entity edges

// Graph traversal
export const MAX_TRAVERSAL_HOPS = 3;
export const DECAY_FACTOR = 0.6; // Score decay per hop
export const TOP_K_NODES = 20; // Max nodes in query subgraph
export const SEED_COUNT = 5; // Max seed nodes per query

// Chunking
export const MAX_CHUNK_SENTENCES = 3; // Max sentences per chunk
export const MIN_CHUNK_LENGTH = 20; // Min characters for a valid chunk
export const MAX_CHUNK_LENGTH = 500; // Max characters per chunk

// TF-IDF
export const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
  'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
  'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
  'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then',
  'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'both',
  'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor',
  'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 'just',
  'because', 'but', 'and', 'or', 'if', 'while', 'about', 'up', 'that',
  'this', 'these', 'those', 'it', 'its', 'he', 'she', 'they', 'them',
  'his', 'her', 'their', 'what', 'which', 'who', 'whom', 'we', 'you',
  'i', 'me', 'my', 'your', 'our', 'also', 'however', 'although',
]);

// Pipeline
export const PIPELINE_BATCH_SIZE = 10; // Process files in batches
