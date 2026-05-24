//! Tiny privacy helper for SDK-side logging.
//!
//! When the SDK is embedded in a consumer app (the Graphnosis App, a CI
//! pipeline, a user's own integration), its console.error / console.warn
//! lines flow into the consumer's stderr buffer — dev terminals, crash
//! reports, OS log aggregators. Anything sensitive that lands there is
//! out of the SDK's control after that.
//!
//! Node ids, source paths, and file references are all potentially
//! sensitive (a path can name a private folder; a node id is stable per
//! cortex and can be cross-referenced). This helper hashes them into a
//! short stable token so internal logs remain greppable across related
//! events without exposing the underlying identifier.
//!
//! Cryptographically weak by design — FNV-1a 32-bit. The point is privacy
//! hygiene in OUR logs, not authentication.

const ZERO_HASH = '00000000';

/**
 * Redact an id (node id, source file path, etc.) into a short stable token
 * suitable for console logs. Pass-through for empty / null / undefined.
 *
 * Same id → same hash across calls (so a single failing operation can be
 * traced through multiple log lines), different id → different hash, no
 * way to recover the original from the token.
 */
export function redactId(id: string | null | undefined): string {
  if (!id) return ZERO_HASH;
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
