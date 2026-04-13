import { NextResponse } from 'next/server';
import { getGraph } from '@/core/graph/graph-store';
import { reflect } from '@/core/optimization/reflection';

// POST: Run the reflection engine (contradiction detection, decay, inference, discovery)
// Can be called on-demand or wired to a cron/scheduled job
export async function POST() {
  const graphData = getGraph();
  if (!graphData || !graphData.tfidfIndex) {
    return NextResponse.json({ error: 'No graph loaded' }, { status: 404 });
  }

  const start = performance.now();
  const result = reflect(graphData, graphData.tfidfIndex);
  const elapsed = Math.round((performance.now() - start) * 100) / 100;

  return NextResponse.json({
    success: true,
    timeMs: elapsed,
    contradictions: result.contradictions.length,
    discoveries: result.discoveries.length,
    superseded: result.superseded,
    decayed: result.decayed,
    inferred: result.inferred,
  });
}
