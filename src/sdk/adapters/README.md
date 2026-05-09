# Graphnosis embedding adapters

Adapters bridge the Graphnosis `EmbeddingAdapter` contract to a specific
embedding provider (OpenAI, Voyage, Cohere, local sentence-transformers,
custom). The core SDK ships with no built-in adapter — you import the one
you want.

## Built-in adapters

### `@nehloo/graphnosis/adapters/openai`

```ts
import { Graphnosis } from '@nehloo/graphnosis';
import { openaiEmbedAdapter } from '@nehloo/graphnosis/adapters/openai';

const g = new Graphnosis({
  name: 'docs',
  embed: openaiEmbedAdapter({ model: 'text-embedding-3-small' }),
});
```

Peer deps: `ai`, `@ai-sdk/openai`. Reads `OPENAI_API_KEY` from the
environment. Symmetric model — `intent` is ignored.

### `@nehloo/graphnosis/adapters/static`

```ts
import { staticEmbedAdapter } from '@nehloo/graphnosis/adapters/static';

const adapter = staticEmbedAdapter({
  vectors: { 'hello': [0.1, 0.2, 0.3], 'world': [0.4, 0.5, 0.6] },
});
```

For tests, offline benchmarks, and CI runs. No peer deps. Throws on lookup
miss by default; pass `onMiss: 'zeros'` to return zero-vectors instead.

## Writing your own adapter

The natural shape for an asymmetric provider (Voyage, Cohere) is a
**bidirectional** adapter — one object that handles both intents per call.
Graphnosis passes `intent` on every `embed()` invocation so the adapter
can route to the right `input_type` without two separate instances.

```ts
import type { EmbeddingAdapter } from '@nehloo/graphnosis';

export function voyageEmbedAdapter(opts: {
  apiKey: string;
  model?: string;
  dimensions?: number;
}): EmbeddingAdapter {
  const model = opts.model ?? 'voyage-3-large';
  const dimensions = opts.dimensions ?? 1024;
  return {
    // Bidirectional adapter — one instance handles both intents — so
    // `id` does NOT include the intent. See "id naming convention" below.
    id: `voyage:${model}@${dimensions}`,
    dimensions,
    async embed(texts, intent = 'document', signal) {
      const res = await fetch('https://api.voyageai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${opts.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          input: texts,
          input_type: intent, // Voyage accepts 'document' / 'query' directly
          output_dimension: dimensions,
        }),
        signal,
      });
      if (!res.ok) throw new Error(`voyage embed failed: ${res.status}`);
      const json = await res.json();
      return json.data.map((d: { embedding: number[] }) => d.embedding);
    },
  };
}
```

### `id` naming convention

By convention, encode every property that affects the vector space — but
*not* properties that are call-time parameters of a single adapter object.

| Property                       | In `id`?                              | Why                                                |
| ------------------------------ | ------------------------------------- | -------------------------------------------------- |
| Provider name                  | Always                                | Different providers' vector spaces don't compare   |
| Model name                     | Always                                | Different models within a provider don't compare   |
| Output dimension               | Always                                | OpenAI `-3-*` models support custom dimensions     |
| Intent (`document` / `query`)  | **Only for pinned-intent adapters**   | See below                                          |

#### Bidirectional vs. pinned-intent adapters

There are two valid shapes for an asymmetric-provider adapter:

1. **Bidirectional (recommended).** One adapter object handles both
   intents per call — Graphnosis passes `intent` on every `embed()`
   invocation, the adapter routes accordingly. The `voyageEmbedAdapter`
   above is bidirectional. Its `id` does **not** include the intent
   suffix because `intent` is a call-time parameter, not a property of
   the object. The vector spaces for `'document'` and `'query'` calls
   differ, but Graphnosis itself guarantees the correct intent at each
   call site (`buildEmbeddings()` always uses `'document'`,
   `queryHybrid()` always uses `'query'`), so cross-contamination is
   impossible by construction.

2. **Pinned-intent.** Two separate adapter instances, one constructed
   for each intent, each with the intent baked into both the API call
   and the `id`. Use this only when the underlying SDK or HTTP client
   forces you to commit to an intent at construction time (rare).
   Example ids: `'voyage:voyage-3-large@1024:document'` and
   `'voyage:voyage-3-large@1024:query'`. If you ship pinned adapters,
   you MUST wire the document-pinned one into `buildEmbeddings()` and
   the query-pinned one into `queryHybrid()` yourself — Graphnosis only
   tracks one default `embed` adapter per `Graphnosis` instance.

In short: if a single adapter object is going to be assigned to
`new Graphnosis({ embed: ... })`, it's bidirectional, and its `id`
should not include the intent.

Examples (good ids):

- `'openai:text-embedding-3-small@1536'` (symmetric model — `intent` ignored)
- `'openai:text-embedding-3-large@3072'`
- `'voyage:voyage-3-large@1024'` (bidirectional)
- `'cohere:embed-english-v3.0@1024'` (bidirectional)

The convention is not validated by Graphnosis. But two adapters with the
same `id` MUST produce vectors in the same space — otherwise loading a
saved index against a different runtime adapter will silently return
garbage instead of throwing `EmbeddingAdapterMismatchError`.

### Asymmetric providers

If your provider distinguishes document vs. query embeddings (Voyage,
Cohere), your `embed()` MUST honor the `intent` parameter:

| Graphnosis `intent` | Voyage `input_type` | Cohere `input_type` |
| ------------------- | ------------------- | ------------------- |
| `'document'`        | `'document'`        | `'search_document'` |
| `'query'`           | `'query'`           | `'search_query'`    |

Symmetric providers (OpenAI) MAY ignore the parameter.

### Cancellation

Forward the `signal: AbortSignal` argument to your underlying HTTP
client. Most modern fetch / SDK clients accept one directly. This lets
consumers cancel a long `buildEmbeddings()` mid-batch on user navigation
or container shutdown.

### Batching and retries

Graphnosis pre-batches inputs (default 256 per call); your adapter is
free to chunk further internally. Implement provider-appropriate retry
and rate-limit backoff inside `embed()` — Graphnosis treats each call as
atomic.

### Testing your adapter without network — the recording adapter pattern

The `EmbeddingAdapter` contract is small enough that you can test
correctness offline by wrapping any adapter in a recorder that captures
every invocation. This is the cleanest way to assert that:

- `intent` is `'document'` during `buildEmbeddings()` and `'query'` during
  `queryHybrid()` (the most common asymmetric-provider footgun).
- `signal` is forwarded to the underlying call.
- The dimension count is honored.
- Batching matches what you expect for your adapter's batch size.

```ts
import type { EmbeddingAdapter } from '@nehloo/graphnosis';
import { staticEmbedAdapter } from '@nehloo/graphnosis/adapters/static';

interface Call {
  texts: string[];
  intent: 'document' | 'query' | undefined;
  hadSignal: boolean;
}

function recordingAdapter(inner: EmbeddingAdapter): EmbeddingAdapter & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    id: inner.id,
    dimensions: inner.dimensions,
    calls,
    async embed(texts, intent, signal) {
      calls.push({ texts: [...texts], intent, hadSignal: !!signal });
      return inner.embed(texts, intent, signal);
    },
  };
}

// In a test:
const inner = staticEmbedAdapter({
  vectors: { /* your fixture vectors */ },
  dimensions: 3,
  onMiss: 'zeros',
});
const adapter = recordingAdapter(inner);

const g = new Graphnosis({ embed: adapter });
g.addMarkdown('…', 'a.md').build();

await g.buildEmbeddings();
// adapter.calls.every(c => c.intent === 'document') ✓

await g.queryHybrid('whatever');
// last call's intent === 'query' ✓
```

This pattern is creds-free, deterministic, and fast enough to run in any
CI. It's how the v0.2.0 release was soaked end-to-end before tagging.
