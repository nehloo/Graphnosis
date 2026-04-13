import { NextResponse } from 'next/server';
import { getGraph } from '@/core/graph/graph-store';
import {
  applyCorrection,
  importCorrections,
  forgetByTimeWindow,
  forgetByTopic,
  cascadeSoftDelete,
} from '@/core/corrections/correction-engine';
import type { Correction } from '@/core/corrections/correction-engine';

// POST: Apply a correction, import bulk, forget by time/topic, or cascade delete
export async function POST(request: Request) {
  const graphData = getGraph();
  if (!graphData || !graphData.tfidfIndex) {
    return NextResponse.json({ error: 'No graph loaded' }, { status: 404 });
  }

  const body = await request.json();

  // Bulk import mode: { markdown: "...", source: "..." }
  if (body.markdown) {
    const result = importCorrections(
      graphData,
      graphData.tfidfIndex,
      body.markdown,
      body.source || 'upload'
    );
    return NextResponse.json({ success: true, result });
  }

  // Bulk forget by time window: { forget: "time", before: "2026-01-01T00:00:00Z" }
  if (body.forget === 'time' && body.before) {
    const before = new Date(body.before).getTime();
    if (isNaN(before)) {
      return NextResponse.json({ error: 'Invalid date for "before"' }, { status: 400 });
    }
    const result = forgetByTimeWindow(graphData, before, body.reason || 'Bulk time-window forgetting');
    return NextResponse.json({ success: true, ...result });
  }

  // Bulk forget by topic: { forget: "topic", topic: "my old job" }
  if (body.forget === 'topic' && body.topic) {
    const result = forgetByTopic(graphData, body.topic, body.reason || `Bulk topic forgetting: ${body.topic}`);
    return NextResponse.json({ success: true, ...result });
  }

  // Cascade soft-delete: { forget: "cascade", nodeId: "..." }
  if (body.forget === 'cascade' && body.nodeId) {
    const result = cascadeSoftDelete(graphData, body.nodeId, body.reason || 'Cascade soft-delete');
    return NextResponse.json({ success: true, ...result });
  }

  // Single correction mode: { type, nodeId?, content?, reason }
  const correction: Correction = {
    type: body.type || 'add',
    nodeId: body.nodeId,
    content: body.content,
    reason: body.reason || 'Human correction',
    timestamp: Date.now(),
  };

  const result = applyCorrection(graphData, graphData.tfidfIndex, correction);

  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  return NextResponse.json({
    success: true,
    affectedNodeId: result.affectedNodeId,
    graphStats: {
      nodeCount: graphData.metadata.nodeCount,
      version: graphData.metadata.version,
    },
  });
}
