import { NextResponse } from 'next/server';
import { fetchAllWikipediaArticles } from '@/examples/wikipedia/fetcher';
import { fetchAllArxivPapers } from '@/examples/arxiv/fetcher';
import { fetchAllNextjsDocs } from '@/examples/nextjs-docs/fetcher';
import { fetchAllNasaMarsData } from '@/examples/nasa-mars/fetcher';
import { fetchAllCCImages } from '@/examples/cc-gallery/fetcher';
import { buildGraph } from '@/core/graph/graph-builder';
import { setGraph } from '@/core/graph/graph-store';
import type { ParsedDocument } from '@/core/types';

const DATASETS: Record<string, {
  name: string;
  fetcher: (onProgress?: (c: number, t: number, title: string) => void) => Promise<ParsedDocument[]>;
  label: string;
}> = {
  wikipedia: {
    name: 'History of Computing (Wikipedia)',
    fetcher: fetchAllWikipediaArticles,
    label: 'Wikipedia',
  },
  arxiv: {
    name: 'Transformer Architecture (arXiv)',
    fetcher: fetchAllArxivPapers,
    label: 'arXiv',
  },
  'nextjs-docs': {
    name: 'Next.js Documentation',
    fetcher: fetchAllNextjsDocs,
    label: 'Next.js Docs',
  },
  'nasa-mars': {
    name: 'NASA Mars Missions',
    fetcher: fetchAllNasaMarsData,
    label: 'NASA Mars',
  },
  'cc-gallery': {
    name: 'Creative Commons Gallery',
    fetcher: fetchAllCCImages,
    label: 'CC Gallery',
  },
};

export async function POST(
  request: Request,
  { params }: { params: Promise<{ dataset: string }> }
) {
  const { dataset } = await params;
  const config = DATASETS[dataset];

  if (!config) {
    return NextResponse.json(
      { error: `Unknown dataset: ${dataset}. Available: ${Object.keys(DATASETS).join(', ')}` },
      { status: 400 }
    );
  }

  try {
    const documents = await config.fetcher((current, total, title) => {
      console.log(`[${config.label}] Fetching ${current}/${total}: ${title}`);
    });

    if (documents.length === 0) {
      return NextResponse.json({ error: 'No documents fetched' }, { status: 500 });
    }

    const result = buildGraph(documents, config.name);
    setGraph(result);

    return NextResponse.json({
      success: true,
      stats: {
        documentsProcessed: documents.length,
        nodeCount: result.metadata.nodeCount,
        directedEdgeCount: result.metadata.directedEdgeCount,
        undirectedEdgeCount: result.metadata.undirectedEdgeCount,
      },
    });
  } catch (err) {
    console.error(`${config.label} pipeline error:`, err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
