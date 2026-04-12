"use client";

import { useState } from "react";

interface GikiPageData {
  title: string;
  slug: string;
  content: string;
  nodeIds: string[];
  generatedAt: number;
}

interface TopicSuggestion {
  topic: string;
  mentions: number;
}

export default function GikiPage() {
  const [topics, setTopics] = useState<TopicSuggestion[]>([]);
  const [selectedPage, setSelectedPage] = useState<GikiPageData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [customTopic, setCustomTopic] = useState("");

  async function loadTopics() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/graph/giki");
      if (!res.ok) throw new Error("No graph loaded. Load a dataset first.");
      const data = await res.json();
      setTopics(data.topics || []);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setLoading(false);
    }
  }

  async function generatePage(topic: string) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/graph/giki?topic=${encodeURIComponent(topic)}`
      );
      if (!res.ok) throw new Error("Failed to generate page");
      const page = await res.json();
      setSelectedPage(page);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setLoading(false);
    }
  }

  function downloadFullGiki() {
    window.open("/api/graph/giki?index=true&format=markdown", "_blank");
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Giki</h1>
          <p className="text-muted text-xs mt-1">
            Human-readable knowledge pages generated from the graph with node citations
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={loadTopics}
            disabled={loading}
            className="px-4 py-2 bg-accent text-white text-sm rounded-md hover:bg-accent-light transition-colors disabled:opacity-40"
          >
            {topics.length > 0 ? "Refresh Topics" : "Load Topics"}
          </button>
          {topics.length > 0 && (
            <button
              onClick={downloadFullGiki}
              className="px-4 py-2 bg-surface-2 text-foreground text-sm rounded-md border border-border hover:bg-surface transition-colors"
            >
              Export All (Markdown)
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="bg-red-950/30 border border-red-800 rounded-lg p-3 text-sm text-red-400">
          {error}
        </div>
      )}

      <div className="flex gap-6">
        {/* Topic sidebar */}
        <div className="w-64 space-y-3">
          {/* Custom topic input */}
          <div className="flex gap-1">
            <input
              value={customTopic}
              onChange={(e) => setCustomTopic(e.target.value)}
              placeholder="Search topic..."
              className="flex-1 bg-surface border border-border rounded px-2 py-1.5 text-xs text-foreground placeholder:text-muted focus:outline-none focus:border-accent"
              onKeyDown={(e) => {
                if (e.key === "Enter" && customTopic.trim()) {
                  generatePage(customTopic.trim());
                }
              }}
            />
            <button
              onClick={() => customTopic.trim() && generatePage(customTopic.trim())}
              disabled={!customTopic.trim() || loading}
              className="px-2 py-1.5 bg-accent text-white text-xs rounded disabled:opacity-40"
            >
              Go
            </button>
          </div>

          {/* Suggested topics */}
          {topics.length > 0 && (
            <div className="bg-surface rounded-lg border border-border p-3 max-h-[60vh] overflow-y-auto">
              <h3 className="text-xs text-muted mb-2">
                Top Topics ({topics.length})
              </h3>
              <div className="space-y-0.5">
                {topics.map((t, i) => (
                  <button
                    key={i}
                    onClick={() => generatePage(t.topic)}
                    className="w-full text-left px-2 py-1 text-xs rounded hover:bg-surface-2 transition-colors flex justify-between items-center"
                  >
                    <span className="text-foreground truncate">
                      {t.topic}
                    </span>
                    <span className="text-muted font-mono ml-2">
                      {t.mentions}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Page content */}
        <div className="flex-1">
          {selectedPage ? (
            <div className="bg-surface rounded-lg border border-border p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-bold">{selectedPage.title}</h2>
                <div className="flex gap-2 text-xs text-muted">
                  <span>{selectedPage.nodeIds.length} node citations</span>
                  <button
                    onClick={() =>
                      window.open(
                        `/api/graph/giki?topic=${encodeURIComponent(selectedPage.title)}&format=markdown`,
                        "_blank"
                      )
                    }
                    className="text-accent hover:underline"
                  >
                    Download .md
                  </button>
                </div>
              </div>
              <div className="prose prose-invert prose-sm max-w-none">
                <pre className="whitespace-pre-wrap text-sm leading-relaxed text-foreground font-sans">
                  {selectedPage.content}
                </pre>
              </div>
            </div>
          ) : (
            <div className="bg-surface rounded-lg border border-border p-8 text-center text-muted text-sm">
              {topics.length > 0
                ? "Select a topic or type a custom one to generate a giki page."
                : 'Click "Load Topics" to see available topics from the graph.'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
