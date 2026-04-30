import type { KnowledgeGraph } from '@/core/types';

// Build a lightweight synonym map from the graph itself
// Entities that co-occur in similar-to edges are likely synonyms or related terms

export interface SynonymMap {
  terms: Map<string, string[]>; // term → related terms
}

export function buildSynonymMap(graph: KnowledgeGraph): SynonymMap {
  const cooccurrence = new Map<string, Map<string, number>>();

  // For each undirected similar-to or shares-entity edge,
  // the entities of both nodes are likely related
  for (const edge of graph.undirectedEdges.values()) {
    if (edge.type !== 'similar-to' && edge.type !== 'shares-entity') continue;
    if (edge.weight < 0.4) continue;

    const nodeA = graph.nodes.get(edge.nodes[0]);
    const nodeB = graph.nodes.get(edge.nodes[1]);
    if (!nodeA || !nodeB) continue;

    // Cross-pollinate entities
    for (const entityA of nodeA.entities) {
      const lowerA = entityA.toLowerCase();
      for (const entityB of nodeB.entities) {
        const lowerB = entityB.toLowerCase();
        if (lowerA === lowerB) continue;

        if (!cooccurrence.has(lowerA)) cooccurrence.set(lowerA, new Map());
        const map = cooccurrence.get(lowerA)!;
        map.set(lowerB, (map.get(lowerB) || 0) + edge.weight);
      }
    }
  }

  // Build synonym map: keep top 5 related terms per entity (by weight)
  const terms = new Map<string, string[]>();

  for (const [term, related] of cooccurrence) {
    const sorted = Array.from(related.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .filter(([, weight]) => weight > 0.5)
      .map(([relatedTerm]) => relatedTerm);

    if (sorted.length > 0) {
      terms.set(term, sorted);
    }
  }

  return { terms };
}

// Expand a query with synonyms from the map
export function expandQuery(query: string, synonymMap: SynonymMap): string[] {
  // Unicode-aware tokenization: extract runs of letters/numbers/marks
  // This handles CJK, Arabic, Devanagari, etc. where \s+ splitting loses characters
  const words = query.toLowerCase().match(/[\p{L}\p{N}\p{M}]+/gu) ?? [];
  const expansions = new Set<string>();
  expansions.add(query); // Original query always included

  for (const word of words) {
    const synonyms = synonymMap.terms.get(word);
    if (synonyms) {
      for (const syn of synonyms) {
        // Create expanded query by replacing the word with its synonym
        const expanded = query.replace(new RegExp(`\\b${word}\\b`, 'gi'), syn);
        if (expanded !== query) {
          expansions.add(expanded);
        }
      }
    }

    // Also check multi-word entities
    for (const [term, synonyms] of synonymMap.terms) {
      if (query.toLowerCase().includes(term)) {
        for (const syn of synonyms.slice(0, 2)) {
          const expanded = query.replace(new RegExp(term, 'gi'), syn);
          if (expanded !== query) {
            expansions.add(expanded);
          }
        }
      }
    }
  }

  return Array.from(expansions).slice(0, 5); // Max 5 query variants
}
