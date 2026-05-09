# The `.gai` Format — AI-Native Knowledge Representation

> **Graphnosis AI** — a binary serialization format for dual-graph knowledge structures,
> designed for machine comprehension rather than human readability.

The `.gai` file is the persistence format at the heart of Graphnosis. A single file contains a complete dual-graph: typed nodes, directed edges (causal/temporal/hierarchical/identity), undirected edges (similarity/co-occurrence), and all provenance/temporal metadata needed to reason over the knowledge without touching the original sources.

---

## Design Principles

1. **AI-native, not human-native.** JSON is optimized for human inspection; `.gai` is optimized for fast machine ingestion. Nothing in the layout is decorative — every byte is either load-bearing structure or integrity check.
2. **Self-describing.** The file declares its version, node/edge counts, and hierarchy levels in a fixed header. A reader can decide up-front whether it can process the file.
3. **Single-file portability.** Graph identity, nodes, edges, source references, and metadata are in one file. No sidecar indexes, no embedded blobs, no external dependencies on a DB.
4. **Integrity first.** Magic bytes guard against wrong-format inputs; a 32-bit checksum guards against truncation/corruption. A bad read fails loudly, never silently.
5. **No embedding vectors.** TF-IDF and entity overlap provide similarity signals; vectors can be re-derived on demand. Keeping vectors out of the file makes it tiny and portable (typical `.gai` files are kilobytes, not megabytes).

---

## Binary Layout

A `.gai` file is a flat byte stream composed of five contiguous regions:

```
┌─────────────────────────────────────────────────────────────────┐
│  [0..3]       MAGIC            0x47 0x41 0x49 0x01  ("GAI\x01") │
│  [4..7]       HEADER_LEN       uint32 big-endian                │
│  [8..8+H]     HEADER           MessagePack-encoded map          │
│  [8+H..N-4]   BODY             MessagePack-encoded map          │
│  [N-4..N-1]   CHECKSUM         uint32 big-endian                │
└─────────────────────────────────────────────────────────────────┘
```

Where `H = HEADER_LEN` and `N` is the total file length.

### Magic bytes (4 B)
`0x47 0x41 0x49 0x01` — ASCII `"GAI"` followed by a format-family byte (`0x01` reserved for the current family; allows future format variants under the same ASCII prefix).

### Header length (4 B)
Big-endian `uint32`. Lets a reader seek directly to the body without parsing MessagePack first.

### Header (variable)
A MessagePack map summarizing the graph:

| Field | Type | Purpose |
|---|---|---|
| `version` | `uint` | Format version (currently `1`) |
| `nodeCount` | `uint` | Number of nodes in the body |
| `directedEdgeCount` | `uint` | Number of directed edges |
| `undirectedEdgeCount` | `uint` | Number of undirected edges |
| `levels` | `uint` | Hierarchy depth (0 = leaves only; 1+ = summary layers) |
| `name` | `string` | Human-readable graph name |
| `id` | `string` | Stable graph identifier |

The header is small enough to parse cheaply — a tool can list/catalog `.gai` files by reading only the first few hundred bytes.

### Body (variable)
A MessagePack map containing the full graph payload:

| Field | Type | Schema |
|---|---|---|
| `nodes` | `array<GraphNode>` | See [Node Schema](#node-schema) |
| `directedEdges` | `array<DirectedEdge>` | See [Directed Edge Schema](#directed-edge-schema) |
| `undirectedEdges` | `array<UndirectedEdge>` | See [Undirected Edge Schema](#undirected-edge-schema) |
| `metadata` | `GraphMetadata` | See [Graph Metadata](#graph-metadata) |

### Checksum (4 B)
Big-endian `uint32`. Computed as the sum of every byte in `HEADER` and `BODY`, masked to 32 bits:

```
checksum = (Σ headerBytes + Σ bodyBytes) & 0xFFFFFFFF
```

On read, the reader recomputes and rejects any file whose stored and computed checksums disagree. This is an integrity check, not a cryptographic hash — it catches truncation and accidental corruption, not adversarial tampering. For authenticated integrity, layer a signature on top of the file (e.g. detached Ed25519).

---

## Node Schema

Every node in the graph follows this shape:

```ts
interface GraphNode {
  id: string;                 // Stable node identifier
  content: string;            // Canonical text (claim, fact, definition, etc.)
  contentHash: string;        // SHA-ish hash for dedup across extractions
  type: NodeType;             // See enumerated types below
  source: {                   // Provenance — always present
    file: string;
    offset: number;
    line?: number;
    section?: string;
  };
  entities: string[];         // Extracted named entities
  metadata: Record<string, string | number>;
  level: number;              // 0 = leaf; 1+ = summary layer
  confidence: number;         // 0..1 — extraction confidence
  // Temporal
  createdAt: number;          // Unix ms
  lastAccessedAt: number;     // Updated by query engine
  accessCount: number;        // Retrieval count (informs decay)
  validUntil?: number;        // Soft-delete / expiry timestamp
}
```

### Node types (`type`)
- **Core knowledge:** `fact`, `concept`, `entity`, `event`, `definition`, `claim`, `data-point`
- **Document structure:** `section`, `document`
- **Identity:** `person`, `organization`, `preference`
- **Conversation:** `conversation`, `message`, `session-summary`
- **Multimodal:** `image`, `video`, `transcript`, `visual-description`

The type drives routing behavior in the query engine — e.g. `preference` nodes outrank `fact` nodes for subjective queries; `session-summary` nodes provide cheap seeds that expand to per-turn detail via `summarizes` edges.

### Temporal fields

`createdAt`, `lastAccessedAt`, `accessCount`, and `validUntil` are what make `.gai` a *living* format rather than a static snapshot:

- **Confidence decay.** After 7 days without access, a node's effective confidence decays ~1%/day (floor 0.1). Frequently-accessed nodes stay sharp; stale nodes fade without being deleted.
- **Soft delete.** Corrections set `validUntil` to "now" and drop confidence to 0.1 instead of removing the node. Full audit trail; nothing is lost.
- **Temporal queries.** The query engine can weight results by recency, filter by time window, or bulk-forget by date.

---

## Directed Edge Schema

```ts
interface DirectedEdge {
  id: string;
  from: NodeId;
  to: NodeId;
  type: DirectedEdgeType;
  weight: number;             // 0..1 — strength of the relationship
  evidence?: string;          // Optional text snippet justifying the edge
  createdAt?: number;
}
```

### Directed edge types
| Type | Semantics |
|---|---|
| `causes` | A produces / triggers B |
| `depends-on` | A requires B to hold |
| `precedes` | A happens before B (temporal ordering) |
| `contains` | A is the parent of B (hierarchical) |
| `defines` | A provides the definition of B |
| `cites` | A references B |
| `contradicts` | A conflicts with B (flagged by reflection engine) |
| `supports` | A corroborates B |
| `supersedes` | B replaces A (correction/update chain) |
| `discussed-in` | Knowledge node → source conversation |
| `knows` / `works-with` / `reports-to` | Person-to-person identity edges |
| `collaborated-on` | Person → document/concept |
| `prefers` | User → concept (preference edges) |
| `summarizes` | Summary node → the turns it compresses |

Directed edges carry the *reasoning* structure of the graph — they are what lets the BFS traverser follow a question through causal chains, supersede-chains, and hierarchical decomposition.

---

## Undirected Edge Schema

```ts
interface UndirectedEdge {
  id: string;
  nodes: [NodeId, NodeId];    // Order is not meaningful
  type: UndirectedEdgeType;
  weight: number;             // 0..1
  createdAt?: number;
}
```

### Undirected edge types
| Type | Semantics |
|---|---|
| `similar-to` | TF-IDF / cosine similarity above threshold |
| `co-occurs` | Nodes appear together in the same chunk |
| `shares-entity` | Nodes share extracted entities |
| `shares-topic` | Nodes cluster under the same topic |
| `same-source` | Nodes came from the same document |
| `same-person` | Two mentions of the same person across sources |
| `related-to` | General inferred relationship |

Undirected edges carry the *associative* structure — they are what lets a query about "coffee" surface a node about "Ethiopian Yirgacheffe" even when no directed chain connects them.

### Why a dual graph?

Most graph formats pick one edge model. Directed-only loses similarity and co-occurrence signal; undirected-only loses causality and hierarchy. Running both over the same node set lets the query engine combine *why-chains* (directed) with *what-neighbors* (undirected) in a single BFS.

---

## Graph Metadata

```ts
interface GraphMetadata {
  createdAt: number;
  updatedAt: number;
  sourceFiles: string[];         // Every source ingested into this graph
  nodeCount: number;
  directedEdgeCount: number;
  undirectedEdgeCount: number;
  version: number;
  conversationCount?: number;    // Populated for conversation graphs
  personCount?: number;          // Populated when identity extraction ran
}
```

Metadata duplicates a few counts that already appear in the header — intentionally. The header exists for fast catalog/listing; the body metadata is the authoritative record alongside the actual data.

---

## Worked Example

A minimal `.gai` might look like this in pseudo-JSON (before MessagePack encoding):

```jsonc
// HEADER (MessagePack-encoded)
{
  "version": 1,
  "nodeCount": 2,
  "directedEdgeCount": 1,
  "undirectedEdgeCount": 0,
  "levels": 0,
  "name": "coffee-notes",
  "id": "g_01H..."
}

// BODY (MessagePack-encoded)
{
  "nodes": [
    {
      "id": "n1",
      "content": "Ethiopian Yirgacheffe is a light roast",
      "contentHash": "a3f...",
      "type": "fact",
      "source": { "file": "notes.md", "offset": 204, "line": 7 },
      "entities": ["Ethiopian Yirgacheffe"],
      "metadata": {},
      "level": 0,
      "confidence": 0.92,
      "createdAt": 1734528000000,
      "lastAccessedAt": 1734528000000,
      "accessCount": 0
    },
    { "id": "n2", "content": "I prefer light roasts", "type": "preference", ... }
  ],
  "directedEdges": [
    { "id": "e1", "from": "n1", "to": "n2", "type": "supports", "weight": 0.75 }
  ],
  "undirectedEdges": [],
  "metadata": {
    "createdAt": 1734528000000,
    "updatedAt": 1734528000000,
    "sourceFiles": ["notes.md"],
    "nodeCount": 2,
    "directedEdgeCount": 1,
    "undirectedEdgeCount": 0,
    "version": 1
  }
}
```

Encoded to bytes, this entire graph is well under 1 KB.

---

## Reading / Writing

The reference implementation lives in [`src/core/format/`](../src/core/format/):

- **[`gai-writer.ts`](../src/core/format/gai-writer.ts)** — `writeGai(graph) → Buffer`
- **[`gai-reader.ts`](../src/core/format/gai-reader.ts)** — `readGai(buffer) → { graph, header }`

Both are ~50 lines. A compatible implementation in another language needs only a MessagePack library plus the magic/header/checksum framing described above.

### Reader algorithm
1. Verify the first 4 bytes match `0x47 0x41 0x49 0x01`. Reject otherwise.
2. Read bytes `[4..7]` as big-endian `uint32` → `headerLen`.
3. MessagePack-decode `[8 .. 8+headerLen)` → header map.
4. MessagePack-decode `[8+headerLen .. len-4)` → body map.
5. Read bytes `[len-4..len)` as big-endian `uint32` → stored checksum.
6. Recompute checksum over header+body bytes; reject on mismatch.
7. Reconstruct the in-memory `KnowledgeGraph` from the body.

### Writer algorithm
1. Convert the in-memory `KnowledgeGraph` (which uses `Map<id, node>` etc.) into arrays.
2. Build the header map with counts, `version`, `levels`, `name`, `id`.
3. MessagePack-encode header and body independently.
4. Sum bytes of header+body → checksum.
5. Emit: `MAGIC ‖ uint32(headerLen) ‖ HEADER ‖ BODY ‖ uint32(checksum)`.

---

## Versioning & Compatibility

- The magic bytes' 4th octet (`0x01`) identifies the format family.
- The header's `version` field identifies the schema version within that family.
- Readers must check both. An unknown family is an immediate reject. An unknown `version` within a known family is implementation-defined — the reference reader currently treats it as a reject.
- Backwards-compatible schema additions (new optional node fields, new edge types) bump a future minor version; breaking changes bump the family byte.

---

## Why Not Just Use …?

| Alternative | Why not |
|---|---|
| **JSON / NDJSON** | Human-readable overhead (~3–5× size), no integrity check, no clean separation of header/body, no type hints for binary buffers. |
| **Parquet / Arrow** | Excellent for columnar analytics over homogeneous rows — but graph payloads are deeply nested and heterogeneous. Schema evolution is heavy. |
| **GraphML / GEXF / GraphSON** | Human-readable XML/JSON; designed for interchange with visualization tools, not for AI ingestion. No provenance or temporal fields. |
| **Protobuf / FlatBuffers** | Require a schema contract; good fit if every consumer compiles from the same `.proto`. `.gai` uses MessagePack precisely because it needs zero schema coordination — the body is self-describing. |
| **Property graph DB export (Neo4j, etc.)** | Tied to a vendor's query/storage layer; not portable as a single-file artifact. |

The goal is not to compete with any of these on their home turf — it is to be the right shape for a specific job: *a self-contained, verifiable, AI-ingestable snapshot of a living knowledge graph, swappable between processes, machines, and organizations*.

---

## Integrity & Tampering

The built-in checksum catches corruption, not tampering. For enterprise deployments where provenance matters:

- Sign the file with an external keypair (e.g. Ed25519 over the full byte stream).
- Store the signature in a sidecar (`my-graph.gai.sig`) or prepend it to the file under a wrapper format.
- Pin the public key in your deployment; verify on load.

See [`enterprise/enterprise.md`](../enterprise/enterprise.md) for the full privacy and deployment architecture — in particular, note that the `.gai` file never leaves the enterprise boundary even when Graphnosis talks to external LLMs.
