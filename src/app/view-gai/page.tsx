"use client";

import { useState } from "react";

interface GaiInspection {
  file: {
    sizeBytes: number;
    sizeKB: number;
    sizeMB: number;
    magicBytes: string;
  };
  header: {
    version: number;
    nodeCount: number;
    directedEdgeCount: number;
    undirectedEdgeCount: number;
    levels: number;
    name: string;
    id: string;
  };
  hexPreview: string[];
  roundTripVerified: boolean;
  decoded: {
    nodeCount: number;
    directedEdgeCount: number;
    undirectedEdgeCount: number;
    sampleNodes: Array<{
      id: string;
      type: string;
      content: string;
      entities: string[];
      confidence: number;
      edgeCount: number;
    }>;
    sampleDirectedEdges: Array<{
      from: string;
      to: string;
      type: string;
      weight: number;
    }>;
    sampleUndirectedEdges: Array<{
      nodes: [string, string];
      type: string;
      weight: number;
    }>;
  };
}

export default function ViewGaiPage() {
  const [data, setData] = useState<GaiInspection | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function inspectGai() {
    setLoading(true);
    setError(null);
    fetch("/api/graph/export?format=inspect")
      .then((r) => {
        if (!r.ok) throw new Error("No graph loaded. Load a dataset first.");
        return r.json();
      })
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }

  function downloadGai() {
    window.open("/api/graph/export?format=binary", "_blank");
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">View .gai</h1>
          <p className="text-muted text-xs mt-1">
            Inspect the AI-native binary format — what the machine sees, decoded for humans
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={inspectGai}
            disabled={loading}
            className="px-4 py-2 bg-accent text-white text-sm rounded-md hover:bg-accent-light transition-colors disabled:opacity-40"
          >
            {loading ? "Inspecting..." : "Inspect .gai"}
          </button>
          {data && (
            <button
              onClick={downloadGai}
              className="px-4 py-2 bg-surface-2 text-foreground text-sm rounded-md border border-border hover:bg-surface transition-colors"
            >
              Download .gai
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="bg-red-950/30 border border-red-800 rounded-lg p-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {data && (
        <>
          {/* File info */}
          <div className="grid grid-cols-4 gap-4">
            <InfoCard label="File Size" value={data.file.sizeKB > 1024 ? `${data.file.sizeMB} MB` : `${data.file.sizeKB} KB`} />
            <InfoCard label="Format" value={data.file.magicBytes.split('(')[1]?.replace(')', '') || 'GAI v1'} />
            <InfoCard label="Round-Trip" value={data.roundTripVerified ? "Verified" : "FAILED"} color={data.roundTripVerified ? "green" : "red"} />
            <InfoCard label="Levels" value={data.header.levels.toString()} />
          </div>

          {/* Header */}
          <div className="bg-surface rounded-lg border border-border p-4">
            <h3 className="text-sm font-medium mb-3">Header (decoded from binary)</h3>
            <div className="grid grid-cols-2 gap-2 text-xs font-mono">
              <div><span className="text-muted">name:</span> {data.header.name}</div>
              <div><span className="text-muted">id:</span> {data.header.id}</div>
              <div><span className="text-muted">version:</span> {data.header.version}</div>
              <div><span className="text-muted">levels:</span> {data.header.levels}</div>
              <div><span className="text-muted">nodes:</span> {data.header.nodeCount.toLocaleString()}</div>
              <div><span className="text-muted">directed edges:</span> {data.header.directedEdgeCount.toLocaleString()}</div>
              <div><span className="text-muted">undirected edges:</span> {data.header.undirectedEdgeCount.toLocaleString()}</div>
            </div>
          </div>

          {/* Hex dump */}
          <div className="bg-surface rounded-lg border border-border p-4">
            <h3 className="text-sm font-medium mb-3">
              Raw Binary (first 256 bytes)
              <span className="text-muted font-normal ml-2">— this is what the .gai file actually looks like</span>
            </h3>
            <pre className="text-[11px] font-mono text-green-400 bg-black/50 rounded p-3 overflow-x-auto leading-relaxed">
              {data.hexPreview.map((line, i) => (
                <div key={i}>
                  <span className="text-muted">{line.slice(0, 10)}</span>
                  <span className="text-green-400">{line.slice(10, 58)}</span>
                  <span className="text-yellow-400">{line.slice(58)}</span>
                </div>
              ))}
            </pre>
            <p className="text-xs text-muted mt-2">
              Left: byte offset. Middle: hex values. Right: ASCII interpretation (dots = non-printable bytes).
              The first 4 bytes are the magic number: <code className="text-green-400">47 41 49 01</code> = "GAI" + version 1.
            </p>
          </div>

          {/* Sample nodes */}
          <div className="bg-surface rounded-lg border border-border p-4">
            <h3 className="text-sm font-medium mb-3">
              Sample Nodes (decoded)
              <span className="text-muted font-normal ml-2">— {data.decoded.nodeCount.toLocaleString()} total in file</span>
            </h3>
            <div className="space-y-2">
              {data.decoded.sampleNodes.map((node) => (
                <div key={node.id} className="bg-surface-2 rounded p-3 text-xs">
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`node-${node.type} font-medium`}>[{node.type}]</span>
                    <span className="text-muted font-mono">{node.id}</span>
                    <span className="text-muted">conf: {(node.confidence * 100).toFixed(0)}%</span>
                    <span className="text-muted">{node.edgeCount} edges</span>
                  </div>
                  <p className="text-foreground leading-relaxed">{node.content}</p>
                  {node.entities.length > 0 && (
                    <div className="flex gap-1 mt-1.5">
                      {node.entities.map((e, i) => (
                        <span key={i} className="px-1.5 py-0.5 bg-surface rounded text-muted font-mono">
                          {e}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Sample edges */}
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-surface rounded-lg border border-border p-4">
              <h3 className="text-sm font-medium mb-3">
                Directed Edges (sample)
                <span className="text-muted font-normal ml-2">— {data.decoded.directedEdgeCount.toLocaleString()} total</span>
              </h3>
              <div className="space-y-1 text-xs font-mono">
                {data.decoded.sampleDirectedEdges.map((e, i) => (
                  <div key={i} className="text-muted">
                    <span className="text-foreground">{e.from.slice(0, 8)}</span>
                    {" "}<span className="text-accent">-[{e.type}:{e.weight.toFixed(1)}]-&gt;</span>{" "}
                    <span className="text-foreground">{e.to.slice(0, 8)}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="bg-surface rounded-lg border border-border p-4">
              <h3 className="text-sm font-medium mb-3">
                Undirected Edges (sample)
                <span className="text-muted font-normal ml-2">— {data.decoded.undirectedEdgeCount.toLocaleString()} total</span>
              </h3>
              <div className="space-y-1 text-xs font-mono">
                {data.decoded.sampleUndirectedEdges.map((e, i) => (
                  <div key={i} className="text-muted">
                    <span className="text-foreground">{e.nodes[0].slice(0, 8)}</span>
                    {" "}<span className="text-yellow-400">~[{e.type}:{e.weight.toFixed(1)}]~</span>{" "}
                    <span className="text-foreground">{e.nodes[1].slice(0, 8)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Explanation */}
          <div className="bg-surface rounded-lg border border-border p-4 text-xs text-muted space-y-2">
            <p>
              <strong className="text-foreground">What you're seeing:</strong> The .gai file is a binary-packed graph using MessagePack serialization. It contains the same information as the in-memory graph but in a compact, non-human-readable format optimized for fast loading and integrity verification.
            </p>
            <p>
              The hex dump shows raw bytes — this is what a machine reads. The decoded sections below show the same data interpreted into nodes, edges, and metadata that humans can understand. The round-trip verification confirms that write → read produces an identical graph.
            </p>
            <p>
              <strong className="text-foreground">Why binary?</strong> A 12K-node graph as JSON would be ~15MB. As .gai (MessagePack), it's typically 40-60% smaller, loads faster, and includes a checksum for integrity verification. The format is designed for AI consumption, not human editing — that's what the Giki and Audit pages are for.
            </p>
          </div>
        </>
      )}
    </div>
  );
}

function InfoCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="bg-surface rounded-lg border border-border p-4">
      <div className={`text-lg font-bold font-mono ${color === 'green' ? 'text-green-400' : color === 'red' ? 'text-red-400' : ''}`}>
        {value}
      </div>
      <div className="text-xs text-muted mt-1">{label}</div>
    </div>
  );
}
