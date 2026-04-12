import { NextResponse } from 'next/server';
import { getGraph } from '@/core/graph/graph-store';
import { applyCorrection, importCorrections } from '@/core/corrections/correction-engine';
import type { Correction } from '@/core/corrections/correction-engine';

// POST: Apply a correction or import bulk corrections
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
