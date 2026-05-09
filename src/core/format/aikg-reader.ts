import { unpack } from 'msgpackr';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { KnowledgeGraph, SerializableGraph } from '@/core/types';
import { AIKG_MAGIC } from '@/core/constants';
import { fromSerializable } from '@/core/graph/graph-store';

export interface AikgHeader {
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

export interface ReadAikgOptions {
  /**
   * Required when the file header declares `integrity: 'hmac-sha256'`. Readers
   * fail closed on any mismatch between header and supplied key: missing key
   * for a signed file, or a key supplied against an unsigned file (prevents
   * downgrade attacks where an attacker strips the HMAC trailer).
   */
  hmacKey?: Buffer | string;
}

export function readAikg(
  buffer: Buffer,
  opts: ReadAikgOptions = {}
): { graph: KnowledgeGraph; header: AikgHeader } {
  for (let i = 0; i < AIKG_MAGIC.length; i++) {
    if (buffer[i] !== AIKG_MAGIC[i]) {
      throw new Error('Invalid .aikg file: magic bytes mismatch');
    }
  }

  const headerLen = buffer.readUInt32BE(AIKG_MAGIC.length);
  const headerBuf = buffer.subarray(AIKG_MAGIC.length + 4, AIKG_MAGIC.length + 4 + headerLen);
  const header = unpack(headerBuf) as AikgHeader;

  const isSigned = header.integrity === 'hmac-sha256';
  const trailerLen = isSigned ? 4 + 32 : 4; // checksum + optional HMAC
  const bodyBuf = buffer.subarray(AIKG_MAGIC.length + 4 + headerLen, buffer.length - trailerLen);

  const storedChecksum = buffer.readUInt32BE(buffer.length - trailerLen);
  let computedChecksum = 0;
  for (const byte of headerBuf) computedChecksum = (computedChecksum + byte) & 0xffffffff;
  for (const byte of bodyBuf) computedChecksum = (computedChecksum + byte) & 0xffffffff;

  if (storedChecksum !== computedChecksum) {
    throw new Error('Invalid .aikg file: checksum mismatch');
  }

  // Fail-closed HMAC handling.
  if (isSigned && !opts.hmacKey) {
    throw new Error('Invalid .aikg file: file is HMAC-signed but no hmacKey was supplied');
  }
  if (!isSigned && opts.hmacKey) {
    throw new Error('Invalid .aikg file: hmacKey supplied but file is not HMAC-signed (possible downgrade)');
  }
  if (isSigned && opts.hmacKey) {
    const storedHmac = buffer.subarray(buffer.length - 32);
    const hmac = createHmac('sha256', opts.hmacKey);
    hmac.update(headerBuf);
    hmac.update(bodyBuf);
    const computedHmac = hmac.digest();
    if (storedHmac.length !== computedHmac.length || !timingSafeEqual(storedHmac, computedHmac)) {
      throw new Error('Invalid .aikg file: HMAC verification failed');
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
