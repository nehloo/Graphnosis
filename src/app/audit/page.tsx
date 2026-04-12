"use client";

import { useState } from "react";

interface HealthReport {
  totalNodes: number;
  totalDirectedEdges: number;
  totalUndirectedEdges: number;
  orphanNodes: number;
  lowConfidenceNodes: number;
  expiredNodes: number;
  enrichedNodes: number;
  unenrichedNodes: number;
  nodesByType: Record<string, number>;
  edgesByType: Record<string, number>;
  avgConfidence: number;
  avgAccessCount: number;
  coverageGaps: string[];
}

interface EntityReport {
  name: string;
  factCount: number;
  sources: string[];
  relatedPersons: string[];
  temporalTrace: {
    accessCount: number;
    confidenceTrend: string;
  };
}

interface AuditData {
  entities: EntityReport[];
  contradictions: Array<{
    contentA: string;
    contentB: string;
    sharedEntities: string[];
  }>;
  discoveries: Array<{
    contentA: string;
    contentB: string;
    sourceA: string;
    sourceB: string;
    bridgeEntities: string[];
    surprise: number;
  }>;
  health: HealthReport;
}

export default function AuditPage() {
  const [data, setData] = useState<AuditData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function runAudit() {
    setLoading(true);
    setError(null);
    fetch("/api/graph/audit")
      .then((r) => {
        if (!r.ok) throw new Error("No graph loaded. Load a dataset first.");
        return r.json();
      })
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }

  function downloadMarkdown() {
    window.open("/api/graph/audit?format=markdown", "_blank");
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Knowledge Audit</h1>
          <p className="text-muted text-xs mt-1">
            Reverse analysis of the graph — entity reports, contradictions, health
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={runAudit}
            disabled={loading}
            className="px-4 py-2 bg-accent text-white text-sm rounded-md hover:bg-accent-light transition-colors disabled:opacity-40"
          >
            {loading ? "Analyzing..." : "Run Audit"}
          </button>
          {data && (
            <button
              onClick={downloadMarkdown}
              className="px-4 py-2 bg-surface-2 text-foreground text-sm rounded-md border border-border hover:bg-surface transition-colors"
            >
              Export Markdown
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
          {/* Health overview */}
          <div className="grid grid-cols-4 gap-4">
            <HealthCard label="Avg Confidence" value={`${(data.health.avgConfidence * 100).toFixed(1)}%`} />
            <HealthCard label="Orphan Nodes" value={data.health.orphanNodes.toString()} warn={data.health.orphanNodes > 50} />
            <HealthCard label="Low Confidence" value={data.health.lowConfidenceNodes.toString()} warn={data.health.lowConfidenceNodes > 20} />
            <HealthCard label="Enriched" value={`${data.health.enrichedNodes} / ${data.health.enrichedNodes + data.health.unenrichedNodes}`} />
          </div>

          {/* Edge type breakdown */}
          <div className="bg-surface rounded-lg border border-border p-4">
            <h3 className="text-sm font-medium mb-3">Edge Type Distribution</h3>
            <div className="flex flex-wrap gap-2">
              {Object.entries(data.health.edgesByType).map(([type, count]) => (
                <span key={type} className="px-2 py-1 text-xs font-mono bg-surface-2 rounded">
                  {type}: {count.toLocaleString()}
                </span>
              ))}
            </div>
          </div>

          {/* Top entities */}
          <div className="bg-surface rounded-lg border border-border p-4">
            <h3 className="text-sm font-medium mb-3">Top Entities ({data.entities.length})</h3>
            <div className="space-y-2 max-h-80 overflow-y-auto">
              {data.entities.slice(0, 30).map((entity, i) => (
                <div key={i} className="flex items-center justify-between text-xs py-1 border-b border-border/30">
                  <div>
                    <span className="font-medium text-foreground">{entity.name}</span>
                    <span className="text-muted ml-2">
                      {entity.factCount} facts, {entity.sources.length} source(s)
                    </span>
                  </div>
                  <span className={`px-1.5 py-0.5 rounded text-xs ${
                    entity.temporalTrace.confidenceTrend === 'stable' ? 'bg-green-900/30 text-green-400' :
                    entity.temporalTrace.confidenceTrend === 'decaying' ? 'bg-red-900/30 text-red-400' :
                    'bg-yellow-900/30 text-yellow-400'
                  }`}>
                    {entity.temporalTrace.confidenceTrend}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Contradictions */}
          {data.contradictions.length > 0 && (
            <div className="bg-surface rounded-lg border border-red-800/30 p-4">
              <h3 className="text-sm font-medium mb-3 text-red-400">
                Contradictions ({data.contradictions.length})
              </h3>
              <div className="space-y-3">
                {data.contradictions.slice(0, 5).map((c, i) => (
                  <div key={i} className="text-xs space-y-1 pb-3 border-b border-border/30">
                    <div className="text-muted">Shared: {c.sharedEntities.join(', ')}</div>
                    <div className="text-foreground">A: {c.contentA.slice(0, 150)}</div>
                    <div className="text-foreground">B: {c.contentB.slice(0, 150)}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Cross-domain discoveries */}
          {data.discoveries.length > 0 && (
            <div className="bg-surface rounded-lg border border-accent/30 p-4">
              <h3 className="text-sm font-medium mb-3 text-accent-light">
                Cross-Domain Discoveries ({data.discoveries.length})
              </h3>
              <div className="space-y-3">
                {data.discoveries.slice(0, 10).map((d, i) => (
                  <div key={i} className="text-xs space-y-1 pb-3 border-b border-border/30">
                    <div className="flex items-center gap-2">
                      <span className="text-accent font-mono">{(d.surprise * 100).toFixed(0)}% surprise</span>
                      <span className="text-muted">via {d.bridgeEntities.join(', ')}</span>
                    </div>
                    <div className="text-muted">{d.sourceA}: "{d.contentA.slice(0, 100)}"</div>
                    <div className="text-muted">{d.sourceB}: "{d.contentB.slice(0, 100)}"</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Coverage gaps */}
          {data.health.coverageGaps.length > 0 && (
            <div className="bg-surface rounded-lg border border-border p-4">
              <h3 className="text-sm font-medium mb-3">Coverage Gaps</h3>
              <p className="text-xs text-muted mb-2">Entities mentioned only once (may need more sources):</p>
              <div className="flex flex-wrap gap-1.5">
                {data.health.coverageGaps.map((gap, i) => (
                  <span key={i} className="px-1.5 py-0.5 text-xs font-mono bg-surface-2 rounded text-muted">
                    {gap}
                  </span>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function HealthCard({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className={`bg-surface rounded-lg border p-4 ${warn ? 'border-yellow-800/50' : 'border-border'}`}>
      <div className={`text-lg font-bold font-mono ${warn ? 'text-yellow-400' : ''}`}>{value}</div>
      <div className="text-xs text-muted mt-1">{label}</div>
    </div>
  );
}
