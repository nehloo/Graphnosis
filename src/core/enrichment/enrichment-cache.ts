// Disk-backed content-hash cache for enrichment passes that call the LLM
// (session summarization in Phase 2, query-time preference extraction in
// Phase 3). LongMemEval sessions overlap heavily across questions, so
// caching by content hash lets a full 500q re-run avoid paying for the
// same summary twice.
//
// Cache layout: data/cache/enrichment/{kind}-{hash}.json
// Schema is versioned — bump CACHE_VERSION when the summarizer prompt or
// response shape changes, and old entries become misses automatically.

import { promises as fs } from 'fs';
import * as path from 'path';

export const CACHE_VERSION = 1;

const CACHE_DIR = path.join(process.cwd(), 'data', 'cache', 'enrichment');

export type EnrichmentKind = 'session-summary' | 'preference-extraction';

interface CacheEnvelope<T> {
  version: number;
  kind: EnrichmentKind;
  hash: string;
  createdAt: number;
  payload: T;
}

function cachePath(kind: EnrichmentKind, hash: string): string {
  return path.join(CACHE_DIR, `${kind}-${hash}.json`);
}

// DJB2 hash — same function used by graph-builder for node dedup.
// Duplicated rather than cross-imported to keep enrichment independent
// of the graph module's internals.
export function hashContent(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) & 0xffffffff;
  }
  return hash.toString(36);
}

export async function readCache<T>(
  kind: EnrichmentKind,
  hash: string
): Promise<T | null> {
  try {
    const raw = await fs.readFile(cachePath(kind, hash), 'utf-8');
    const envelope = JSON.parse(raw) as CacheEnvelope<T>;
    if (envelope.version !== CACHE_VERSION) return null;
    if (envelope.kind !== kind) return null;
    return envelope.payload;
  } catch {
    return null;
  }
}

export async function writeCache<T>(
  kind: EnrichmentKind,
  hash: string,
  payload: T
): Promise<void> {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  const envelope: CacheEnvelope<T> = {
    version: CACHE_VERSION,
    kind,
    hash,
    createdAt: Date.now(),
    payload,
  };
  await fs.writeFile(cachePath(kind, hash), JSON.stringify(envelope, null, 2));
}
