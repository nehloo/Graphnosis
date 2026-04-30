import { nanoid } from 'nanoid';
import type {
  KnowledgeGraph,
  GraphNode,
  DirectedEdge,
  UndirectedEdge,
  NodeId,
  PersonProfile,
  UserProfile,
} from '@/core/types';

// Extract person and organization entities from the graph
// and create dedicated identity nodes with relationship edges

export function extractIdentities(graph: KnowledgeGraph): {
  persons: PersonProfile[];
  newNodes: number;
  newEdges: number;
} {
  const startNodes = graph.nodes.size;
  const startEdges = graph.directedEdges.size + graph.undirectedEdges.size;

  // Collect all person-like entities across all nodes
  const entityMentions = new Map<string, { nodeIds: NodeId[]; count: number; firstSeen: number; lastSeen: number }>();

  for (const [nodeId, node] of graph.nodes) {
    for (const entity of node.entities) {
      // Filter for likely person names (two+ capitalized words)
      if (isLikelyPerson(entity)) {
        const normalized = normalizeName(entity);
        const existing = entityMentions.get(normalized) || {
          nodeIds: [],
          count: 0,
          firstSeen: node.createdAt,
          lastSeen: node.createdAt,
        };
        existing.nodeIds.push(nodeId);
        existing.count++;
        existing.firstSeen = Math.min(existing.firstSeen, node.createdAt);
        existing.lastSeen = Math.max(existing.lastSeen, node.createdAt);
        entityMentions.set(normalized, existing);
      }
    }
  }

  // Create person nodes for entities mentioned 2+ times
  const persons: PersonProfile[] = [];

  for (const [name, mentions] of entityMentions) {
    if (mentions.count < 2) continue;

    const personNodeId = nanoid();

    // Extract attributes from surrounding content
    const attributes = inferPersonAttributes(name, mentions.nodeIds, graph);

    const personNode: GraphNode = {
      id: personNodeId,
      content: buildPersonContent(name, attributes),
      contentHash: `person:${name}`,
      type: 'person',
      source: { file: 'identity-extraction', offset: 0 },
      entities: [name],
      metadata: {
        personName: name,
        mentionCount: mentions.count,
        ...attributes,
      },
      level: 0,
      confidence: Math.min(0.5 + mentions.count * 0.1, 0.95),
      createdAt: mentions.firstSeen,
      lastAccessedAt: Date.now(),
      accessCount: 0,
    };

    graph.nodes.set(personNodeId, personNode);

    // Create "discussed-in" edges from person to mentioning nodes
    for (const mentioningNodeId of mentions.nodeIds) {
      const edge: DirectedEdge = {
        id: nanoid(),
        from: mentioningNodeId,
        to: personNodeId,
        type: 'cites',
        weight: 0.6,
        evidence: `Mentions ${name}`,
        createdAt: Date.now(),
      };
      graph.directedEdges.set(edge.id, edge);
    }

    // Create "same-person" edges between nodes that mention this person
    for (let i = 0; i < mentions.nodeIds.length; i++) {
      for (let j = i + 1; j < Math.min(i + 5, mentions.nodeIds.length); j++) {
        const edge: UndirectedEdge = {
          id: nanoid(),
          nodes: [mentions.nodeIds[i], mentions.nodeIds[j]],
          type: 'shares-entity',
          weight: 0.5,
          createdAt: Date.now(),
        };
        graph.undirectedEdges.set(edge.id, edge);
      }
    }

    persons.push({
      nodeId: personNodeId,
      name,
      aliases: [],
      attributes,
      firstMentionedAt: mentions.firstSeen,
      lastMentionedAt: mentions.lastSeen,
      mentionCount: mentions.count,
    });
  }

  // Detect relationships between persons (co-mentioned in same nodes)
  for (let i = 0; i < persons.length; i++) {
    for (let j = i + 1; j < persons.length; j++) {
      const personA = persons[i];
      const personB = persons[j];
      const aMentions = entityMentions.get(personA.name)!;
      const bMentions = entityMentions.get(personB.name)!;

      // Check if they're co-mentioned in any node
      const overlap = aMentions.nodeIds.filter(id => bMentions.nodeIds.includes(id));
      if (overlap.length > 0) {
        const edge: UndirectedEdge = {
          id: nanoid(),
          nodes: [personA.nodeId, personB.nodeId],
          type: 'related-to',
          weight: Math.min(0.3 + overlap.length * 0.1, 0.9),
          createdAt: Date.now(),
        };
        graph.undirectedEdges.set(edge.id, edge);
      }
    }
  }

  // Update metadata
  graph.metadata.nodeCount = graph.nodes.size;
  graph.metadata.directedEdgeCount = graph.directedEdges.size;
  graph.metadata.undirectedEdgeCount = graph.undirectedEdges.size;
  graph.metadata.personCount = persons.length;

  return {
    persons,
    newNodes: graph.nodes.size - startNodes,
    newEdges: (graph.directedEdges.size + graph.undirectedEdges.size) - startEdges,
  };
}

function isLikelyPerson(entity: string): boolean {
  // Two+ words, each capitalized, not all-caps (acronym), not a year
  const words = entity.split(/\s+/);
  if (words.length < 2) return false;
  if (/^\d+$/.test(entity)) return false;
  if (entity === entity.toUpperCase()) return false; // Skip acronyms

  // Unicode-aware: matches capitalized words in Latin, Cyrillic, Greek, Armenian, Georgian, etc.
  return words.every(w => /^\p{Lu}\p{Ll}+$/u.test(w));
}

function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

function inferPersonAttributes(
  name: string,
  nodeIds: NodeId[],
  graph: KnowledgeGraph
): Record<string, string> {
  const attributes: Record<string, string> = {};

  // Search surrounding content for role/title indicators
  for (const nodeId of nodeIds.slice(0, 10)) {
    const node = graph.nodes.get(nodeId);
    if (!node) continue;

    const content = node.content.toLowerCase();
    const nameLower = name.toLowerCase();
    const nameIdx = content.indexOf(nameLower);
    if (nameIdx === -1) continue;

    // Look for role patterns near the name
    const surrounding = content.slice(Math.max(0, nameIdx - 100), nameIdx + name.length + 100);

    const rolePatterns = [
      // English
      /(?:professor|dr\.|researcher|scientist|engineer|mathematician|inventor|pioneer|founder)/i,
      /(?:ceo|cto|president|director|manager|lead)/i,
      // French
      /(?:professeur|chercheur|scientifique|ingénieur|mathématicien|inventeur|fondateur|directeur)/i,
      // Spanish
      /(?:profesor|investigador|científico|ingeniero|matemático|inventor|fundador|director)/i,
      // German
      /(?:Professor|Forscher|Wissenschaftler|Ingenieur|Mathematiker|Erfinder|Gründer|Direktor)/i,
      // Italian
      /(?:professore|ricercatore|scienziato|ingegnere|matematico|inventore|fondatore|direttore)/i,
      // Portuguese
      /(?:professor|pesquisador|cientista|engenheiro|matemático|inventor|fundador|diretor)/i,
      // Romanian
      /(?:profesor|cercetător|om de știință|inginer|matematician|inventator|fondator|director)/i,
      // Russian
      /(?:профессор|исследователь|учёный|инженер|математик|изобретатель|основатель|директор)/i,
      // Turkish
      /(?:profesör|araştırmacı|bilim insanı|mühendis|matematikçi|mucit|kurucu|müdür)/i,
      // Arabic
      /(?:أستاذ|باحث|عالم|مهندس|رياضي|مخترع|مؤسس|مدير)/,
      // Japanese
      /(?:教授|研究者|科学者|技術者|数学者|発明者|創設者|所長)/,
      // Chinese
      /(?:教授|研究员|科学家|工程师|数学家|发明家|创始人|主任)/,
      // Korean
      /(?:교수|연구원|과학자|엔지니어|수학자|발명가|창립자|이사)/,
    ];

    for (const pattern of rolePatterns) {
      const match = surrounding.match(pattern);
      if (match && !attributes.role) {
        attributes.role = match[0];
      }
    }

    // Look for organization/institution (multilingual prepositions + Unicode names)
    const orgPatterns = [
      // English: at/of/from + capitalized name + optional institution suffix
      /(?:at|of|from)\s+(?:the\s+)?(\p{Lu}\p{Ll}+(?:\s+\p{Lu}\p{Ll}+)*(?:\s+(?:University|Institute|Lab|Corporation|Inc|Company))?)/u,
      // French: à/de/du + institution
      /(?:à|de|du)\s+(?:l[ae']?\s+)?(\p{Lu}\p{Ll}+(?:\s+\p{Lu}\p{Ll}+)*(?:\s+(?:Université|Institut|Laboratoire|Société))?)/u,
      // Spanish: en/de/del + institution
      /(?:en|de|del)\s+(?:la\s+)?(\p{Lu}\p{Ll}+(?:\s+\p{Lu}\p{Ll}+)*(?:\s+(?:Universidad|Instituto|Laboratorio|Empresa))?)/u,
      // German: an/von/bei + institution
      /(?:an|von|bei)\s+(?:der\s+|dem\s+)?(\p{Lu}\p{Ll}+(?:\s+\p{Lu}\p{Ll}+)*(?:\s+(?:Universität|Institut|Labor|Gesellschaft|GmbH|AG))?)/u,
      // Romanian: la/de la/din + institution
      /(?:la|de la|din)\s+(\p{Lu}\p{Ll}+(?:\s+\p{Lu}\p{Ll}+)*(?:\s+(?:Universitatea|Institutul|Laboratorul|Compania))?)/u,
      // Russian: в/из/при + institution
      /(?:в|из|при)\s+(\p{Lu}\p{Ll}+(?:\s+\p{Lu}\p{Ll}+)*(?:\s+(?:Университет|Институт|Лаборатория|Компания))?)/u,
      // Italian: a/di/da + institution
      /(?:presso|di|da)\s+(?:l[ao']?\s+)?(\p{Lu}\p{Ll}+(?:\s+\p{Lu}\p{Ll}+)*(?:\s+(?:Università|Istituto|Laboratorio|Società))?)/u,
      // Portuguese: em/de/da + institution
      /(?:na|no|da|do)\s+(\p{Lu}\p{Ll}+(?:\s+\p{Lu}\p{Ll}+)*(?:\s+(?:Universidade|Instituto|Laboratório|Empresa))?)/u,
    ];
    for (const pattern of orgPatterns) {
      const match = surrounding.match(pattern);
      if (match && !attributes.organization) {
        attributes.organization = match[1];
      }
    }
  }

  return attributes;
}

function buildPersonContent(name: string, attributes: Record<string, string>): string {
  const parts = [name];
  if (attributes.role) parts.push(`(${attributes.role})`);
  if (attributes.organization) parts.push(`at ${attributes.organization}`);
  return parts.join(' ');
}

// Infer user preferences from conversation patterns
export function inferUserProfile(
  graph: KnowledgeGraph,
  conversationNodeIds: NodeId[]
): UserProfile {
  const preferences = new Map<string, number>();
  const domains: string[] = [];

  // Count entity frequency across user messages in conversations
  for (const nodeId of conversationNodeIds) {
    const node = graph.nodes.get(nodeId);
    if (!node || node.metadata.role !== 'user') continue;

    for (const entity of node.entities) {
      preferences.set(entity, (preferences.get(entity) || 0) + 1);
    }
  }

  // Top domains = most frequently mentioned entities by the user
  const sorted = Array.from(preferences.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20);

  for (const [entity] of sorted.slice(0, 10)) {
    domains.push(entity);
  }

  return {
    nodeId: 'user-profile',
    preferences,
    communicationStyle: {
      prefersBullets: false,
      prefersDetail: 'unknown',
      technicalDepth: 'unknown',
    },
    domains,
    inferredAt: Date.now(),
  };
}
