import { NextResponse } from 'next/server';
import { openai } from '@ai-sdk/openai';
import { generateText } from 'ai';
import { getGraph } from '@/core/graph/graph-store';
import {
  getEnrichmentCandidates,
  getNodeNeighborhood,
  buildEnrichmentPrompt,
  parseEnrichmentResponse,
  applyEnrichment,
} from '@/core/enrichment/node-enricher';
import { redactId } from '@/sdk/log-redact';

// POST: Run LLM enrichment on graph nodes
// Body: { maxNodes?: number } — defaults to 50
export async function POST(request: Request) {
  const graphData = getGraph();
  if (!graphData) {
    return NextResponse.json({ error: 'No graph loaded' }, { status: 404 });
  }

  const body = await request.json().catch(() => ({}));
  const maxNodes = Math.min(body.maxNodes || 50, 200);

  // Check if OpenAI API key is available
  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json(
      { error: 'OPENAI_API_KEY required for enrichment. Add it to .env.local.' },
      { status: 400 }
    );
  }

  const candidates = getEnrichmentCandidates(graphData, maxNodes);
  let enriched = 0;
  let failed = 0;
  let totalTokens = 0;

  for (const nodeId of candidates) {
    const node = graphData.nodes.get(nodeId);
    if (!node) continue;

    const neighbors = getNodeNeighborhood(graphData, nodeId);
    const prompt = buildEnrichmentPrompt(node, neighbors, graphData.name);

    try {
      const result = await generateText({
        model: openai('gpt-4o-mini'),
        prompt,
        maxOutputTokens: 300,
      });

      const data = parseEnrichmentResponse(result.text);
      if (data) {
        applyEnrichment(node, data);
        enriched++;
      } else {
        failed++;
      }

      totalTokens += result.usage?.totalTokens || 0;

      // Small delay between calls
      await new Promise(r => setTimeout(r, 200));
    } catch (err) {
      console.error(`Enrichment failed for node[${redactId(nodeId)}]:`, err);
      failed++;
    }
  }

  // Update confidence for enriched nodes (enriched = validated = higher confidence)
  for (const nodeId of candidates) {
    const node = graphData.nodes.get(nodeId);
    if (node?.metadata.synthesis) {
      node.confidence = Math.min(node.confidence + 0.05, 0.98);
    }
  }

  graphData.metadata.updatedAt = Date.now();

  return NextResponse.json({
    success: true,
    enriched,
    failed,
    totalCandidates: candidates.length,
    estimatedTokens: totalTokens,
    estimatedCost: `~$${(totalTokens * 0.00000015).toFixed(4)}`, // gpt-4o-mini pricing
  });
}
