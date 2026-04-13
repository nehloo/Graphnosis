"use client";

import { useState } from "react";

interface TestResult {
  name: string;
  category: string;
  passed: boolean;
  matchedKeywords: string[];
  expectedKeywords: string[];
  totalNodes: number;
  timeMs: number;
}

interface BenchmarkData {
  results: TestResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    accuracy: number;
    avgTimeMs: number;
    byCategory: Record<string, { passed: number; total: number }>;
  };
}

export default function LongMemEvalPage() {
  const [data, setData] = useState<BenchmarkData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function runBenchmark() {
    setLoading(true);
    setError(null);
    fetch("/api/graph/longmemeval")
      .then((r) => {
        if (!r.ok) throw new Error("Failed to run benchmark");
        return r.json();
      })
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">LongMemEval</h1>
          <p className="text-muted text-xs mt-1">
            Knowledge retention benchmark — 12 tests across 4 categories
          </p>
        </div>
        <button
          onClick={runBenchmark}
          disabled={loading}
          className="px-4 py-2 bg-accent text-white text-sm rounded-md hover:bg-accent-light transition-colors disabled:opacity-40"
        >
          {loading ? "Running 12 tests..." : "Run LongMemEval"}
        </button>
      </div>

      {error && (
        <div className="bg-red-950/30 border border-red-800 rounded-lg p-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {data && (
        <>
          {/* Overall score */}
          <div className="bg-surface rounded-lg border border-border p-6 text-center">
            <div
              className={`text-5xl font-bold font-mono ${
                data.summary.accuracy >= 90
                  ? "text-green-400"
                  : data.summary.accuracy >= 70
                  ? "text-yellow-400"
                  : "text-red-400"
              }`}
            >
              {data.summary.accuracy.toFixed(1)}%
            </div>
            <div className="text-sm text-muted mt-1">
              {data.summary.passed} / {data.summary.total} tests passed
            </div>
            <div className="text-xs text-muted mt-0.5">
              Avg {data.summary.avgTimeMs}ms per test
            </div>
          </div>

          {/* Per-category breakdown */}
          <div className="grid grid-cols-4 gap-4">
            {Object.entries(data.summary.byCategory).map(
              ([category, { passed, total }]) => {
                const pct = (passed / total) * 100;
                return (
                  <div
                    key={category}
                    className="bg-surface rounded-lg border border-border p-4"
                  >
                    <div
                      className={`text-2xl font-bold font-mono ${
                        pct >= 90
                          ? "text-green-400"
                          : pct >= 50
                          ? "text-yellow-400"
                          : "text-red-400"
                      }`}
                    >
                      {passed}/{total}
                    </div>
                    <div className="text-xs text-muted mt-1">{category}</div>
                  </div>
                );
              }
            )}
          </div>

          {/* Results table */}
          <div className="bg-surface rounded-lg border border-border overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-xs text-muted">
                  <th className="text-left px-4 py-3 font-medium w-8">
                    Status
                  </th>
                  <th className="text-left px-4 py-3 font-medium">Test</th>
                  <th className="text-left px-4 py-3 font-medium">Category</th>
                  <th className="text-left px-4 py-3 font-medium">
                    Matched Keywords
                  </th>
                  <th className="text-right px-4 py-3 font-medium">Nodes</th>
                  <th className="text-right px-4 py-3 font-medium">Time</th>
                </tr>
              </thead>
              <tbody>
                {data.results.map((r, i) => (
                  <tr
                    key={i}
                    className="border-b border-border/50 hover:bg-surface-2"
                  >
                    <td className="px-4 py-2.5 text-center">
                      {r.passed ? (
                        <span className="text-green-400 text-lg">&#10003;</span>
                      ) : (
                        <span className="text-red-400 text-lg">&#10007;</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-xs">{r.name}</td>
                    <td className="px-4 py-2.5 text-xs text-muted">
                      {r.category}
                    </td>
                    <td className="px-4 py-2.5 text-xs">
                      <div className="flex flex-wrap gap-1">
                        {r.expectedKeywords.map((kw, j) => (
                          <span
                            key={j}
                            className={`px-1.5 py-0.5 rounded font-mono ${
                              r.matchedKeywords.includes(kw)
                                ? "bg-green-900/30 text-green-400"
                                : "bg-red-900/30 text-red-400"
                            }`}
                          >
                            {kw}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-xs">
                      {r.totalNodes}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-xs">
                      {r.timeMs}ms
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Methodology */}
          <div className="bg-surface rounded-lg border border-border p-4 text-xs text-muted space-y-2">
            <p>
              <strong className="text-foreground">Methodology:</strong> Modeled
              after{" "}
              <a
                href="https://github.com/xiaowu0162/LongMemEval"
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent hover:underline"
              >
                LongMemEval
              </a>{" "}
              (Wanget al., 2025). Each test builds a self-contained graph from
              test documents, runs a query through the full pipeline (synonym
              expansion, query decomposition, seed finding, BFS traversal,
              subgraph extraction), and checks if the retrieved nodes contain the
              expected keywords.
            </p>
            <p>
              <strong className="text-foreground">Pass criteria:</strong> A test
              passes if at least 50% of expected keywords appear in the retrieved
              subgraph. This measures <em>retrieval recall</em> — whether the
              graph traversal finds the right nodes — not LLM answer quality.
            </p>
            <p>
              <strong className="text-foreground">Categories:</strong>{" "}
              Single-Session Recall (can it retrieve facts from one document?),
              Multi-Source Recall (can it connect facts across documents?),
              Knowledge Update (can it handle corrections and superseded info?),
              Temporal Reasoning (can it reason about chronological order?).
            </p>
          </div>
        </>
      )}
    </div>
  );
}
