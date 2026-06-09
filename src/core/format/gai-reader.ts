import { unpack } from 'msgpackr';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { KnowledgeGraph, SerializableGraph } from '@/core/types';
import { GAI_MAGIC } from '@/core/constants';
import { fromSerializable } from '@/core/graph/graph-store';

export interface GaiHeader {
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

export interface ReadGaiOptions {
  /**
   * Required when the file header declares `integrity: 'hmac-sha256'`. Readers
   * fail closed on any mismatch between header and supplied key: missing key
   * for a signed file, or a key supplied against an unsigned file (prevents
   * downgrade attacks where an attacker strips the HMAC trailer).
   */
  hmacKey?: Buffer | string;
}

export function readGai(
  buffer: Buffer,
  opts: ReadGaiOptions = {}
): { graph: KnowledgeGraph; header: GaiHeader } {
  for (let i = 0; i < GAI_MAGIC.length; i++) {
    if (buffer[i] !== GAI_MAGIC[i]) {
      throw new Error('Invalid .gai file: magic bytes mismatch');
    }
  }

  // Authenticate BEFORE parsing (finding #17). The signed-ness of a file lives
  // inside the msgpack header, but unpacking attacker-controlled header bytes
  // before verifying them feeds the deserializer unauthenticated input. We break
  // the cycle by deriving the trailer layout from whether the CALLER supplied a
  // key — not from the header content — so the HMAC can be checked over the raw
  // header+body byte range first, and `unpack` only ever runs on bytes that have
  // passed the checksum (and, in signed mode, the HMAC).
  const signedMode = opts.hmacKey != null;
  const trailerLen = signedMode ? 4 + 32 : 4; // checksum + optional HMAC

  if (buffer.length < GAI_MAGIC.length + 4 + trailerLen) {
    throw new Error('Invalid .gai file: truncated');
  }
  const headerLen = buffer.readUInt32BE(GAI_MAGIC.length);
  const headerStart = GAI_MAGIC.length + 4;
  const headerEnd = headerStart + headerLen;
  if (headerLen === 0 || headerEnd > buffer.length - trailerLen) {
    throw new Error('Invalid .gai file: header length out of range');
  }
  const headerBuf = buffer.subarray(headerStart, headerEnd);
  const bodyBuf = buffer.subarray(headerEnd, buffer.length - trailerLen);

  const storedChecksum = buffer.readUInt32BE(buffer.length - trailerLen);
  let computedChecksum = 0;
  // MUST use `>>> 0` (unsigned), NOT `& 0xffffffff`. The writer uses `>>> 0`
  // (see gai-writer.ts) — JS bitwise `&` returns a SIGNED int32, which goes
  // negative once the running sum's bit 31 is set (cumulative byte-sum > 2^31,
  // i.e. ~17 MB of body). `storedChecksum` is unsigned (readUInt32BE), so a
  // signed `computedChecksum` never matches above that threshold and every
  // large engram falsely fails the checksum on read. The bytes were always
  // valid; only this comparison was wrong.
  for (const byte of headerBuf) computedChecksum = (computedChecksum + byte) >>> 0;
  for (const byte of bodyBuf) computedChecksum = (computedChecksum + byte) >>> 0;

  if (storedChecksum !== computedChecksum) {
    throw new Error('Invalid .gai file: checksum mismatch');
  }

  // In signed mode, verify the HMAC over the raw header+body bytes BEFORE any
  // unpack runs. Same coverage the writer uses (`headerBuf || bodyBuf`), so this
  // is a pure reordering — no format change.
  if (signedMode) {
    const storedHmac = buffer.subarray(buffer.length - 32);
    const hmac = createHmac('sha256', opts.hmacKey!);
    hmac.update(headerBuf);
    hmac.update(bodyBuf);
    const computedHmac = hmac.digest();
    if (storedHmac.length !== computedHmac.length || !timingSafeEqual(storedHmac, computedHmac)) {
      throw new Error('Invalid .gai file: HMAC verification failed');
    }
  }

  // Header bytes are now authenticated (signed mode) or checksum-verified
  // (unsigned mode); safe to unpack.
  const header = unpack(headerBuf) as GaiHeader;
  const isSigned = header.integrity === 'hmac-sha256';

  // Fail-closed downgrade handling: the header's declared signed-ness must match
  // how we read it. (A signed file read without a key fails the checksum above,
  // since its 32-byte HMAC trailer is misattributed as body — but keep these
  // explicit guards for the cases that reach here.)
  if (isSigned && !signedMode) {
    throw new Error('Invalid .gai file: file is HMAC-signed but no hmacKey was supplied');
  }
  if (!isSigned && signedMode) {
    throw new Error('Invalid .gai file: hmacKey supplied but file is not HMAC-signed (possible downgrade)');
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
