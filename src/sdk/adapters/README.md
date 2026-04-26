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

```ts
import type { EmbeddingAdapter } from '@nehloo/graphnosis';

export function voyageEmbedAdapter(opts: { model: string; intent: 'document' | 'query' }): EmbeddingAdapter {
  return {
    // Encode model + dims + intent in the id — Graphnosis fails closed
    // when an index is loaded against a different adapter id.
    id: `voyage:${opts.model}@1024:${opts.intent}`,
    dimensions: 1024,
    async embed(texts, intent, signal) {
      const res = await fetch('https://api.voyageai.com/v1/embeddings', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.VOYAGE_API_KEY}` },
        body: JSON.stringify({
          model: opts.model,
          input: texts,
          input_type: intent === 'query' ? 'query' : 'document',
        }),
        signal,
      });
      const json = await res.json();
      return json.data.map((d: { embedding: number[] }) => d.embedding);
    },
  };
}
```

### `id` naming convention

By convention, encode every property that affects the vector space:

| Property                       | Why it matters                                     |
| ------------------------------ | -------------------------------------------------- |
| Provider name                  | Different providers' vector spaces don't compare   |
| Model name                     | Different models within a provider don't compare   |
| Output dimension               | OpenAI `-3-*` models support custom dimensions     |
| Intent (if asymmetric)         | Voyage/Cohere doc and query spaces differ          |

Examples:

- `'openai:text-embedding-3-small@1536'`
- `'openai:text-embedding-3-large@3072'`
- `'voyage:voyage-3-large@1024:document'`
- `'voyage:voyage-3-large@1024:query'`
- `'cohere:embed-english-v3.0@1024:document'`

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
