import { NextResponse } from 'next/server';
import { getGraph } from '@/core/graph/graph-store';
import { writeGai } from '@/core/format/gai-writer';
import { readGai } from '@/core/format/gai-reader';

// GET: Export the current graph as .gai and show what's inside
// ?format=binary → download the raw .gai file
// ?format=inspect → show decoded structure + hex preview
export async function GET(request: Request) {
  const url = new URL(request.url);
  const format = url.searchParams.get('format') || 'inspect';

  const graphData = getGraph();
  if (!graphData) {
    return NextResponse.json({ error: 'No graph loaded' }, { status: 404 });
  }

  // Write the graph to .gai binary
  const gaiBuf = writeGai(graphData);

  if (format === 'binary') {
    return new Response(new Uint8Array(gaiBuf), {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${graphData.name.replace(/[^a-zA-Z0-9]/g, '-')}.gai"`,
      },
    });
  }

  // Read it back to verify round-trip integrity
  const { graph: decoded, header } = readGai(gaiBuf);

  // Build hex preview of first 256 bytes
  const hexLines: string[] = [];
  for (let i = 0; i < Math.min(gaiBuf.length, 256); i += 16) {
    const slice = gaiBuf.subarray(i, i + 16);
    const hex = Array.from(slice).map(b => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = Array.from(slice).map(b => (b >= 32 && b < 127) ? String.fromCharCode(b) : '.').join('');
    hexLines.push(`${i.toString(16).padStart(8, '0')}  ${hex.padEnd(48)}  ${ascii}`);
  }

  // Sample nodes from the decoded graph
  const sampleNodes = Array.from(decoded.nodes.values()).slice(0, 10).map(n => ({
    id: n.id,
    type: n.type,
    content: n.content.slice(0, 150) + (n.content.length > 150 ? '...' : ''),
    entities: n.entities.slice(0, 5),
    confidence: n.confidence,
    edgeCount: countEdges(decoded, n.id),
  }));

  // Sample edges
  const sampleDirected = Array.from(decoded.directedEdges.values()).slice(0, 10).map(e => ({
    from: e.from,
    to: e.to,
    type: e.type,
    weight: e.weight,
  }));

  const sampleUndirected = Array.from(decoded.undirectedEdges.values()).slice(0, 10).map(e => ({
    nodes: e.nodes,
    type: e.type,
    weight: e.weight,
  }));

  return NextResponse.json({
    file: {
      sizeBytes: gaiBuf.length,
      sizeKB: Math.round(gaiBuf.length / 1024 * 10) / 10,
      sizeMB: Math.round(gaiBuf.length / (1024 * 1024) * 100) / 100,
      magicBytes: `0x${gaiBuf[0].toString(16)} 0x${gaiBuf[1].toString(16)} 0x${gaiBuf[2].toString(16)} 0x${gaiBuf[3].toString(16)} ("${String.fromCharCode(gaiBuf[0])}${String.fromCharCode(gaiBuf[1])}${String.fromCharCode(gaiBuf[2])}" + version ${gaiBuf[3]})`,
    },
    header,
    hexPreview: hexLines,
    roundTripVerified: decoded.nodes.size === graphData.nodes.size,
    decoded: {
      nodeCount: decoded.nodes.size,
      directedEdgeCount: decoded.directedEdges.size,
      undirectedEdgeCount: decoded.undirectedEdges.size,
      sampleNodes,
      sampleDirectedEdges: sampleDirected,
      sampleUndirectedEdges: sampleUndirected,
    },
  });
}

function countEdges(graph: ReturnType<typeof readGai>['graph'], nodeId: string): number {
  let count = 0;
  for (const e of graph.directedEdges.values()) {
    if (e.from === nodeId || e.to === nodeId) count++;
  }
  for (const e of graph.undirectedEdges.values()) {
    if (e.nodes[0] === nodeId || e.nodes[1] === nodeId) count++;
  }
  return count;
}
