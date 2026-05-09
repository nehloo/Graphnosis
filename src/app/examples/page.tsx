"use client";

import { useState } from "react";

const DATASETS = [
  {
    id: "wikipedia",
    name: "History of Computing",
    source: "Wikipedia",
    license: "CC BY-SA 3.0",
    description: "~50 interconnected articles covering computing pioneers, foundational machines, theoretical concepts, programming history, and the internet.",
    contentTypes: ["Wikitext", "Cross-references", "Timelines", "Tables"],
    articleCount: 50,
    ready: true,
  },
  {
    id: "arxiv",
    name: "Transformer Architecture",
    source: "arXiv",
    license: "Open Access",
    description: "~20-30 papers on attention mechanisms and transformers, starting from 'Attention Is All You Need' through modern LLM architectures.",
    contentTypes: ["Abstracts", "Citations", "Metadata"],
    articleCount: 25,
    ready: true,
  },
  {
    id: "nextjs-docs",
    name: "Next.js Documentation",
    source: "GitHub (vercel/next.js)",
    license: "MIT",
    description: "Key Next.js docs including App Router, API reference, guides, and configuration from the official repo.",
    contentTypes: ["Markdown", "Code examples", "API refs"],
    articleCount: 30,
    ready: true,
  },
  {
    id: "nasa-mars",
    name: "NASA Mars Missions",
    source: "api.nasa.gov",
    license: "Public Domain",
    description: "Mars rover photo metadata from Curiosity, plus curated mission facts about Mars rovers, climate, and geology.",
    contentTypes: ["JSON metadata", "Mission facts", "Rover data"],
    articleCount: 16,
    ready: true,
  },
  {
    id: "cc-gallery",
    name: "Creative Commons Gallery",
    source: "Wikimedia Commons",
    license: "CC BY-SA / Public Domain",
    description: "Curated images from Wikimedia Commons — space, computing history, nature, architecture. Multimodal: image metadata becomes graph nodes.",
    contentTypes: ["Image metadata", "EXIF data", "Descriptions", "Categories"],
    articleCount: 10,
    ready: true,
  },
];

export default function ExamplesPage() {
  const [loading, setLoading] = useState<string | null>(null);
  const [result, setResult] = useState<{
    dataset: string;
    stats: { documentsProcessed: number; nodeCount: number; directedEdgeCount: number; undirectedEdgeCount: number };
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadDataset(datasetId: string) {
    setLoading(datasetId);
    setError(null);
    setResult(null);

    try {
      const res = await fetch(`/api/examples/${datasetId}`, { method: "POST" });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Failed to load dataset");
        return;
      }

      setResult({ dataset: datasetId, stats: data.stats });
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Example Datasets</h1>
        <p className="text-muted text-sm mt-1">
          Load a public dataset to see Graphnosis in action. All content is freely licensed.
        </p>
      </div>

      {result && (
        <div className="bg-green-950/30 border border-green-800 rounded-lg p-4 text-sm">
          <span className="text-green-400 font-medium">Loaded successfully.</span>{" "}
          {result.stats.documentsProcessed} documents processed into{" "}
          {result.stats.nodeCount.toLocaleString()} nodes,{" "}
          {result.stats.directedEdgeCount.toLocaleString()} directed edges,{" "}
          {result.stats.undirectedEdgeCount.toLocaleString()} undirected edges.
        </div>
      )}

      {error && (
        <div className="bg-red-950/30 border border-red-800 rounded-lg p-4 text-sm text-red-400">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {DATASETS.map((dataset) => (
          <div
            key={dataset.id}
            className="bg-surface rounded-lg border border-border p-5 space-y-3"
          >
            <div className="flex items-start justify-between">
              <div>
                <h3 className="font-semibold text-sm">{dataset.name}</h3>
                <p className="text-xs text-muted mt-0.5">
                  {dataset.source} &middot; {dataset.license}
                </p>
              </div>
              {!dataset.ready && (
                <span className="px-2 py-0.5 text-xs rounded bg-surface-2 text-muted border border-border">
                  Coming soon
                </span>
              )}
            </div>

            <p className="text-xs text-muted leading-relaxed">{dataset.description}</p>

            <div className="flex flex-wrap gap-1.5">
              {dataset.contentTypes.map((type) => (
                <span
                  key={type}
                  className="px-1.5 py-0.5 text-xs rounded bg-surface-2 text-muted font-mono"
                >
                  {type}
                </span>
              ))}
            </div>

            <button
              onClick={() => loadDataset(dataset.id)}
              disabled={!dataset.ready || loading !== null}
              className="w-full mt-2 px-3 py-2 text-sm rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed bg-accent text-white hover:bg-accent-light"
            >
              {loading === dataset.id
                ? "Loading... (this may take a minute)"
                : `Load ${dataset.articleCount} items`}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
