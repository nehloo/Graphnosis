import { NextResponse } from 'next/server';
import { getGraph } from '@/core/graph/graph-store';
import { generateAuditReport, auditToMarkdown } from '@/core/audit/audit-exporter';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const format = url.searchParams.get('format') || 'json';

  const graphData = getGraph();
  if (!graphData) {
    return NextResponse.json({ error: 'No graph loaded' }, { status: 404 });
  }

  const report = generateAuditReport(graphData, graphData.tfidfIndex);

  if (format === 'markdown') {
    const markdown = auditToMarkdown(report, graphData.name);
    return new Response(markdown, {
      headers: {
        'Content-Type': 'text/markdown',
        'Content-Disposition': `attachment; filename="audit-${graphData.id}.md"`,
      },
    });
  }

  return NextResponse.json(report);
}
