import { NextResponse } from 'next/server';
import { getGraph } from '@/core/graph/graph-store';
import { generateGikiPage, generateGikiIndex, generateGikiIndexPage } from '@/core/giki/giki-generator';

// GET: Generate giki pages
// ?topic=Alan+Turing → single page
// ?index=true → all pages with index
export async function GET(request: Request) {
  const url = new URL(request.url);
  const topic = url.searchParams.get('topic');
  const generateIndex = url.searchParams.get('index') === 'true';
  const format = url.searchParams.get('format') || 'json';

  const graphData = getGraph();
  if (!graphData) {
    return NextResponse.json({ error: 'No graph loaded' }, { status: 404 });
  }

  if (topic) {
    const page = generateGikiPage(graphData, topic);

    if (format === 'markdown') {
      return new Response(page.content, {
        headers: {
          'Content-Type': 'text/markdown',
          'Content-Disposition': `attachment; filename="${page.slug}.md"`,
        },
      });
    }

    return NextResponse.json(page);
  }

  if (generateIndex) {
    const pages = generateGikiIndex(graphData);
    const indexPage = generateGikiIndexPage(pages, graphData.name);

    if (format === 'markdown') {
      // Return all pages as a single combined markdown
      const combined = [indexPage, '', '---', ''];
      for (const page of pages) {
        combined.push(page.content, '', '---', '');
      }
      return new Response(combined.join('\n'), {
        headers: {
          'Content-Type': 'text/markdown',
          'Content-Disposition': 'attachment; filename="giki-full.md"',
        },
      });
    }

    return NextResponse.json({
      index: indexPage,
      pages: pages.map(p => ({
        title: p.title,
        slug: p.slug,
        nodeCount: p.nodeIds.length,
        generatedAt: p.generatedAt,
      })),
      totalPages: pages.length,
      totalNodeCitations: pages.reduce((s, p) => s + p.nodeIds.length, 0),
    });
  }

  // Default: list available topics
  const entityCounts = new Map<string, number>();
  for (const [, node] of graphData.nodes) {
    for (const entity of node.entities) {
      entityCounts.set(entity, (entityCounts.get(entity) || 0) + 1);
    }
  }

  const topics = Array.from(entityCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 50)
    .map(([entity, count]) => ({ topic: entity, mentions: count }));

  return NextResponse.json({ topics });
}
