"use client";

import { useState } from "react";

export default function CorrectPage() {
  const [mode, setMode] = useState<"single" | "bulk" | "forget">("single");
  const [type, setType] = useState<"add" | "edit" | "supersede" | "delete">("add");
  const [nodeId, setNodeId] = useState("");
  const [content, setContent] = useState("");
  const [reason, setReason] = useState("");
  const [markdown, setMarkdown] = useState("");
  const [forgetType, setForgetType] = useState<"time" | "topic" | "cascade">("topic");
  const [forgetValue, setForgetValue] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submitCorrection() {
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      let body;
      if (mode === "bulk") {
        body = { markdown, source: "manual-upload" };
      } else if (mode === "forget") {
        if (forgetType === "time") {
          body = { forget: "time", before: forgetValue, reason: reason || "Bulk time-window forgetting" };
        } else if (forgetType === "topic") {
          body = { forget: "topic", topic: forgetValue, reason: reason || `Forget topic: ${forgetValue}` };
        } else {
          body = { forget: "cascade", nodeId: forgetValue, reason: reason || "Cascade soft-delete" };
        }
      } else {
        body = { type, nodeId: nodeId || undefined, content, reason };
      }

      const res = await fetch("/api/graph/correct", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      if (mode === "bulk") {
        setResult(
          `Imported ${data.result.nodesAdded} nodes. ${data.result.errors.length} errors.`
        );
      } else if (mode === "forget") {
        const count = data.forgotten ?? data.cascaded ?? 0;
        setResult(`${count} nodes forgotten.`);
      } else {
        setResult(
          `Correction applied. Node: ${data.affectedNodeId}. Graph v${data.graphStats?.version}.`
        );
      }

      setContent("");
      setReason("");
      setMarkdown("");
      setForgetValue("");
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Corrections</h1>
        <p className="text-muted text-xs mt-1">
          Add facts, correct errors, or upload new knowledge into the graph
        </p>
      </div>

      {/* Mode toggle */}
      <div className="flex gap-2">
        <button
          onClick={() => setMode("single")}
          className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
            mode === "single"
              ? "bg-accent text-white"
              : "bg-surface-2 text-muted border border-border"
          }`}
        >
          Single Correction
        </button>
        <button
          onClick={() => setMode("bulk")}
          className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
            mode === "bulk"
              ? "bg-accent text-white"
              : "bg-surface-2 text-muted border border-border"
          }`}
        >
          Bulk Import (Markdown)
        </button>
        <button
          onClick={() => setMode("forget")}
          className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
            mode === "forget"
              ? "bg-red-600 text-white"
              : "bg-surface-2 text-muted border border-border"
          }`}
        >
          Forget
        </button>
      </div>

      {result && (
        <div className="bg-green-950/30 border border-green-800 rounded-lg p-3 text-sm text-green-400">
          {result}
        </div>
      )}
      {error && (
        <div className="bg-red-950/30 border border-red-800 rounded-lg p-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {mode === "forget" ? (
        <div className="space-y-4 bg-surface rounded-lg border border-red-800/30 p-5">
          {/* Forget type selector */}
          <div>
            <label className="text-xs text-muted block mb-1">Forget Method</label>
            <div className="flex gap-2">
              {(["topic", "time", "cascade"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setForgetType(t)}
                  className={`px-3 py-1 text-xs rounded transition-colors ${
                    forgetType === t
                      ? "bg-red-600 text-white"
                      : "bg-surface-2 text-muted border border-border"
                  }`}
                >
                  {t === "topic" ? "By Topic" : t === "time" ? "By Time Window" : "Cascade from Node"}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="text-xs text-muted block mb-1">
              {forgetType === "topic"
                ? "Topic to forget (matches entities and content)"
                : forgetType === "time"
                ? "Forget everything created before (ISO date)"
                : "Node ID to cascade soft-delete from"}
            </label>
            <input
              value={forgetValue}
              onChange={(e) => setForgetValue(e.target.value)}
              placeholder={
                forgetType === "topic"
                  ? "e.g., my old job"
                  : forgetType === "time"
                  ? "e.g., 2026-01-01"
                  : "e.g., HRQ0kKjDPAMuw8wHYnDcJ"
              }
              className="w-full bg-surface-2 border border-border rounded px-3 py-2 text-sm text-foreground placeholder:text-muted focus:outline-none focus:border-red-600"
            />
          </div>

          <div>
            <label className="text-xs text-muted block mb-1">Reason (optional)</label>
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why is this being forgotten?"
              className="w-full bg-surface-2 border border-border rounded px-3 py-2 text-sm text-foreground placeholder:text-muted focus:outline-none focus:border-accent"
            />
          </div>

          <button
            onClick={submitCorrection}
            disabled={loading || !forgetValue.trim()}
            className="px-4 py-2 bg-red-600 text-white text-sm rounded-md hover:bg-red-500 transition-colors disabled:opacity-40"
          >
            {loading ? "Forgetting..." : "Forget"}
          </button>

          <p className="text-xs text-muted">
            Forgetting is a soft-delete. Nodes are marked with validUntil and confidence 0.1. They remain in the graph for audit purposes but score 0.3x in queries — effectively invisible.
          </p>
        </div>
      ) : mode === "single" ? (
        <div className="space-y-4 bg-surface rounded-lg border border-border p-5">
          {/* Type selector */}
          <div>
            <label className="text-xs text-muted block mb-1">Correction Type</label>
            <div className="flex gap-2">
              {(["add", "edit", "supersede", "delete"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setType(t)}
                  className={`px-3 py-1 text-xs rounded transition-colors ${
                    type === t
                      ? "bg-accent text-white"
                      : "bg-surface-2 text-muted border border-border"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          {/* Node ID (for edit/supersede/delete) */}
          {(type === "edit" || type === "supersede" || type === "delete") && (
            <div>
              <label className="text-xs text-muted block mb-1">
                Node ID (from graph inspector or audit)
              </label>
              <input
                value={nodeId}
                onChange={(e) => setNodeId(e.target.value)}
                placeholder="e.g., HRQ0kKjDPAMuw8wHYnDcJ"
                className="w-full bg-surface-2 border border-border rounded px-3 py-2 text-sm text-foreground placeholder:text-muted focus:outline-none focus:border-accent"
              />
            </div>
          )}

          {/* Content (for add/edit/supersede) */}
          {type !== "delete" && (
            <div>
              <label className="text-xs text-muted block mb-1">
                {type === "add"
                  ? "New fact or knowledge"
                  : type === "edit"
                  ? "Corrected content"
                  : "New content (replaces old)"}
              </label>
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                rows={4}
                placeholder="Enter the fact, correction, or new information..."
                className="w-full bg-surface-2 border border-border rounded px-3 py-2 text-sm text-foreground placeholder:text-muted focus:outline-none focus:border-accent resize-y"
              />
            </div>
          )}

          {/* Reason */}
          <div>
            <label className="text-xs text-muted block mb-1">Reason for correction</label>
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why is this correction needed?"
              className="w-full bg-surface-2 border border-border rounded px-3 py-2 text-sm text-foreground placeholder:text-muted focus:outline-none focus:border-accent"
            />
          </div>

          <button
            onClick={submitCorrection}
            disabled={loading || (!content && type !== "delete")}
            className="px-4 py-2 bg-accent text-white text-sm rounded-md hover:bg-accent-light transition-colors disabled:opacity-40"
          >
            {loading ? "Applying..." : "Apply Correction"}
          </button>
        </div>
      ) : (
        <div className="space-y-4 bg-surface rounded-lg border border-border p-5">
          <div>
            <label className="text-xs text-muted block mb-1">
              Paste markdown with facts, corrections, or new knowledge
            </label>
            <textarea
              value={markdown}
              onChange={(e) => setMarkdown(e.target.value)}
              rows={12}
              placeholder={`# New Knowledge\n\n## Section 1\nFact one goes here.\n\nFact two goes here.\n\n## Section 2\nMore facts...`}
              className="w-full bg-surface-2 border border-border rounded px-3 py-2 text-sm text-foreground placeholder:text-muted focus:outline-none focus:border-accent resize-y font-mono"
            />
          </div>
          <button
            onClick={submitCorrection}
            disabled={loading || !markdown.trim()}
            className="px-4 py-2 bg-accent text-white text-sm rounded-md hover:bg-accent-light transition-colors disabled:opacity-40"
          >
            {loading ? "Importing..." : "Import into Graph"}
          </button>
        </div>
      )}

      {/* How it works */}
      <div className="bg-surface rounded-lg border border-border p-4 text-xs text-muted space-y-2">
        <p><strong className="text-foreground">How corrections work:</strong></p>
        <ul className="list-disc list-inside space-y-1 ml-2">
          <li><strong>Add:</strong> Creates a new node with confidence 1.0 (human-provided)</li>
          <li><strong>Edit:</strong> Updates an existing node's content and re-extracts entities</li>
          <li><strong>Supersede:</strong> Creates a new node + a supersedes edge from old to new. Old node's confidence drops to 0.3</li>
          <li><strong>Delete:</strong> Soft-deletes by setting validUntil to now. Node remains in graph but scores 0.3x in queries</li>
          <li><strong>Bulk import:</strong> Parses markdown into chunks, each becomes a new node with confidence 1.0</li>
          <li><strong>Forget by topic:</strong> Soft-deletes all nodes matching a topic (entity or content match)</li>
          <li><strong>Forget by time:</strong> Soft-deletes all nodes created before a given date</li>
          <li><strong>Cascade:</strong> Soft-deletes a node and all nodes from the same source or connected via contains edges</li>
        </ul>
      </div>
    </div>
  );
}
