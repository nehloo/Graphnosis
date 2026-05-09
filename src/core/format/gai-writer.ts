import { pack } from 'msgpackr';
import { createHmac } from 'node:crypto';
import type { KnowledgeGraph } from '@/core/types';
import { GAI_MAGIC, GAI_VERSION } from '@/core/constants';
import { toSerializable } from '@/core/graph/graph-store';

export interface WriteGaiOptions {
  /**
   * When set, the file is signed with HMAC-SHA256 over `headerBuf || bodyBuf`.
   * Readers must supply the same key. Use this for any `.gai` file crossing a
   * trust boundary — the default additive checksum only catches corruption,
   * not a motivated attacker.
   */
  hmacKey?: Buffer | string;
}

export function writeGai(graph: KnowledgeGraph, opts: WriteGaiOptions = {}): Buffer {
  const serializable = toSerializable(graph);

  const header: Record<string, unknown> = {
    version: GAI_VERSION,
    nodeCount: serializable.metadata.nodeCount,
    directedEdgeCount: serializable.metadata.directedEdgeCount,
    undirectedEdgeCount: serializable.metadata.undirectedEdgeCount,
    levels: serializable.levels,
    name: serializable.name,
    id: serializable.id,
  };
  if (opts.hmacKey) header.integrity = 'hmac-sha256';

  const body = {
    nodes: serializable.nodes,
    directedEdges: serializable.directedEdges,
    undirectedEdges: serializable.undirectedEdges,
    metadata: serializable.metadata,
  };

  const headerBuf = pack(header);
  const bodyBuf = pack(body);

  // Additive checksum (catches corruption, NOT tampering).
  let checksum = 0;
  for (const byte of headerBuf) checksum = (checksum + byte) & 0xffffffff;
  for (const byte of bodyBuf) checksum = (checksum + byte) & 0xffffffff;

  const headerLenBuf = Buffer.alloc(4);
  headerLenBuf.writeUInt32BE(headerBuf.length, 0);

  const checksumBuf = Buffer.alloc(4);
  checksumBuf.writeUInt32BE(checksum, 0);

  const parts: Buffer[] = [
    Buffer.from(GAI_MAGIC),
    headerLenBuf,
    headerBuf,
    bodyBuf,
    checksumBuf,
  ];

  if (opts.hmacKey) {
    const hmac = createHmac('sha256', opts.hmacKey);
    hmac.update(headerBuf);
    hmac.update(bodyBuf);
    parts.push(hmac.digest()); // 32 bytes
  }

  return Buffer.concat(parts);
}
