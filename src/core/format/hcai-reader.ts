import { unpack } from 'msgpackr';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { KnowledgeGraph, SerializableGraph } from '@/core/types';
import { HCAI_MAGIC } from '@/core/constants';
import { fromSerializable } from '@/core/graph/graph-store';

export interface HcaiHeader {
  version: number;
  nodeCount: number;
  directedEdgeCount: number;
  undirectedEdgeCount: number;
  levels: number;
  name: string;
  id: string;
  /** Present only when the file was written with an HMAC trailer. */
  integrity?: 'hmac-sha256';
}

export interface ReadHcaiOptions {
  /**
   * Required when the file header declares `integrity: 'hmac-sha256'`. Readers
   * fail closed on any mismatch between header and supplied key: missing key
   * for a signed file, or a key supplied against an unsigned file (prevents
   * downgrade attacks where an attacker strips the HMAC trailer).
   */
  hmacKey?: Buffer | string;
}

export function readHcai(
  buffer: Buffer,
  opts: ReadHcaiOptions = {}
): { graph: KnowledgeGraph; header: HcaiHeader } {
  for (let i = 0; i < HCAI_MAGIC.length; i++) {
    if (buffer[i] !== HCAI_MAGIC[i]) {
      throw new Error('Invalid .hcai file: magic bytes mismatch');
    }
  }

  const headerLen = buffer.readUInt32BE(HCAI_MAGIC.length);
  const headerStart = HCAI_MAGIC.length + 4;
  const headerBuf = buffer.subarray(headerStart, headerStart + headerLen);
  const header = unpack(headerBuf) as HcaiHeader;

  const isSigned = header.integrity === 'hmac-sha256';
  const trailerLen = isSigned ? 4 + 32 : 4; // checksum + optional HMAC
  const bodyBuf = buffer.subarray(headerStart + headerLen, buffer.length - trailerLen);

  const storedChecksum = buffer.readUInt32BE(buffer.length - trailerLen);
  let computedChecksum = 0;
  for (const byte of headerBuf) computedChecksum = (computedChecksum + byte) & 0xffffffff;
  for (const byte of bodyBuf) computedChecksum = (computedChecksum + byte) & 0xffffffff;

  if (storedChecksum !== computedChecksum) {
    throw new Error('Invalid .hcai file: checksum mismatch');
  }

  // Fail-closed HMAC handling.
  if (isSigned && !opts.hmacKey) {
    throw new Error('Invalid .hcai file: file is HMAC-signed but no hmacKey was supplied');
  }
  if (!isSigned && opts.hmacKey) {
    throw new Error('Invalid .hcai file: hmacKey supplied but file is not HMAC-signed (possible downgrade)');
  }
  if (isSigned && opts.hmacKey) {
    const storedHmac = buffer.subarray(buffer.length - 32);
    const hmac = createHmac('sha256', opts.hmacKey);
    hmac.update(headerBuf);
    hmac.update(bodyBuf);
    const computedHmac = hmac.digest();
    if (storedHmac.length !== computedHmac.length || !timingSafeEqual(storedHmac, computedHmac)) {
      throw new Error('Invalid .hcai file: HMAC verification failed');
    }
  }

  const body = unpack(bodyBuf) as {
    nodes: SerializableGraph['nodes'];
    directedEdges: SerializableGraph['directedEdges'];
    undirectedEdges: SerializableGraph['undirectedEdges'];
    metadata: SerializableGraph['metadata'];
  };

  const serializable: SerializableGraph = {
    id: header.id,
    name: header.name,
    nodes: body.nodes,
    directedEdges: body.directedEdges,
    undirectedEdges: body.undirectedEdges,
    levels: header.levels,
    metadata: body.metadata,
  };

  return {
    graph: fromSerializable(serializable),
    header,
  };
}
