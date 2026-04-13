"use client";

import { useEffect, useState } from "react";

interface BenchmarkResult {
  query: string;
  timeMs: number;
  seedCount: number;
  nodeCount: number;
  edgeCount: number;
  serializedTokenEstimate: number;
  topSeedScore: number;
}

interface BenchmarkData {
  graphStats: {
    totalNodes: number;
    totalDirectedEdges: number;
    totalUndirectedEdges: number;
    graphName: string;
  };
  benchmarks: BenchmarkResult[];
  summary: {
    avgQueryTimeMs: number;
    avgNodesRetrieved: number;
    avgTokenEstimate: number;
    queriesRun: number;
  };
}

export default function BenchmarkPage() {
  const [data, setData] = useState<BenchmarkData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function runBenchmark() {
    setLoading(true);
    setError(null);
    fetch("/api/graph/benchmark")
      .then((r) => {
        if (!r.ok) throw new Error("No graph loaded. Load a dataset first.");
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
          <h1 className="text-2xl font-bold tracking-tight">Benchmarks</h1>
          <p className="text-muted text-xs mt-1">
            Query performance metrics for the loaded knowledge graph
          </p>
        </div>
        <button
          onClick={runBenchmark}
          disabled={loading}
          className="px-4 py-2 bg-accent text-white text-sm rounded-md hover:bg-accent-light transition-colors disabled:opacity-40"
        >
          {loading ? "Running..." : "Run Benchmarks"}
        </button>
      </div>

      {error && (
        <div className="bg-red-950/30 border border-red-800 rounded-lg p-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {data && (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-4 gap-4">
            <SummaryCard label="Avg Query Time" value={`${data.summary.avgQueryTimeMs}ms`} />
            <SummaryCard label="Avg Nodes Retrieved" value={data.summary.avgNodesRetrieved.toString()} />
            <SummaryCard label="Avg Token Estimate" value={data.summary.avgTokenEstimate.toLocaleString()} />
            <SummaryCard label="Graph Size" value={`${data.graphStats.totalNodes.toLocaleString()} nodes`} />
          </div>

          {/* Results table */}
          <div className="bg-surface rounded-lg border border-border overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-xs text-muted">
                  <th className="text-left px-4 py-3 font-medium">Query</th>
                  <th className="text-right px-4 py-3 font-medium">Time</th>
                  <th className="text-right px-4 py-3 font-medium">Seeds</th>
                  <th className="text-right px-4 py-3 font-medium">Nodes</th>
                  <th className="text-right px-4 py-3 font-medium">Edges</th>
                  <th className="text-right px-4 py-3 font-medium">~Tokens</th>
                  <th className="text-right px-4 py-3 font-medium">Top Score</th>
                </tr>
              </thead>
              <tbody>
                {data.benchmarks.map((b, i) => (
                  <tr key={i} className="border-b border-border/50 hover:bg-surface-2">
                    <td className="px-4 py-2.5 text-xs max-w-xs truncate">{b.query}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-xs">
                      <span className={b.timeMs < 50 ? "text-green-400" : b.timeMs < 200 ? "text-yellow-400" : "text-red-400"}>
                        {b.timeMs}ms
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-xs">{b.seedCount}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-xs">{b.nodeCount}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-xs">{b.edgeCount}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-xs">{b.serializedTokenEstimate.toLocaleString()}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-xs">{b.topSeedScore.toFixed(3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Explanation */}
          <div className="bg-surface rounded-lg border border-border p-4 text-xs text-muted space-y-2">
            <p><strong className="text-foreground">How it works:</strong> Each query is processed through the Bignosis pipeline:</p>
            <ol className="list-decimal list-inside space-y-1 ml-2">
              <li>TF-IDF matching finds seed nodes (most relevant to the query)</li>
              <li>BFS traversal with score decay collects a subgraph from seed nodes</li>
              <li>The subgraph is serialized into a structured format for the LLM</li>
              <li>Token estimate is ~4 characters per token</li>
            </ol>
            <p className="mt-2"><strong className="text-foreground">vs. flat RAG:</strong> Standard RAG returns unconnected text chunks. Bignosis returns a structured subgraph with typed nodes and edges, giving the LLM explicit relationship information for reasoning.</p>
          </div>
        </>
      )}
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-surface rounded-lg border border-border p-4">
      <div className="text-lg font-bold font-mono">{value}</div>
      <div className="text-xs text-muted mt-1">{label}</div>
    </div>
  );
}
