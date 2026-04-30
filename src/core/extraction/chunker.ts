import type { ExtractedChunk, ParsedDocument, ParsedSection, NodeType } from '@/core/types';
import { MIN_CHUNK_LENGTH, MAX_CHUNK_LENGTH, MAX_CHUNK_SENTENCES } from '@/core/constants';
import { extractEntities } from './entity-extractor';

export function chunkDocument(doc: ParsedDocument): ExtractedChunk[] {
  const chunks: ExtractedChunk[] = [];
  let order = 0;

  // Create a document-level chunk
  const docChunkId = `doc:${doc.sourceFile}`;
  chunks.push({
    content: doc.title,
    type: 'document',
    source: { file: doc.sourceFile, offset: 0 },
    entities: extractEntities(doc.title),
    metadata: { ...doc.metadata, title: doc.title },
    order: order++,
    links: [],
  });

  // Process each section recursively. Pass doc.metadata so per-document
  // context (e.g., sessionDate / sessionId for LongMemEval) propagates to
  // every child chunk - previously it was lost, which meant temporal
  // questions had zero date grounding at query time.
  for (const section of doc.sections) {
    chunkSection(section, chunks, doc.sourceFile, docChunkId, order, doc.metadata);
    order = chunks.length;
  }

  return chunks;
}

function chunkSection(
  section: ParsedSection,
  chunks: ExtractedChunk[],
  sourceFile: string,
  parentId: string,
  startOrder: number,
  inheritedMetadata: Record<string, string | number> = {}
): void {
  let order = startOrder;

  // Section header as a node
  const sectionId = `section:${sourceFile}:${section.title}`;
  chunks.push({
    content: section.title,
    type: 'section',
    source: { file: sourceFile, offset: 0, section: section.title },
    entities: extractEntities(section.title),
    metadata: { ...inheritedMetadata, depth: section.depth },
    parentId,
    order: order++,
    links: [],
  });

  // Split section content into chunks
  if (section.content.length > 0) {
    const textChunks = splitIntoChunks(section.content);
    for (const text of textChunks) {
      if (text.length < MIN_CHUNK_LENGTH) continue;

      const links = extractLinks(text);
      const entities = extractEntities(text);
      const type = classifyChunk(text);

      chunks.push({
        content: text,
        type,
        source: { file: sourceFile, offset: 0, section: section.title },
        entities,
        metadata: { ...inheritedMetadata, sectionTitle: section.title },
        parentId: sectionId,
        order: order++,
        links,
      });
    }
  }

  // Recurse into children
  for (const child of section.children) {
    chunkSection(child, chunks, sourceFile, sectionId, order, inheritedMetadata);
    order = chunks.length;
  }
}

function splitIntoChunks(text: string): string[] {
  const paragraphs = text.split(/\n\n+/).filter(p => p.trim().length > 0);
  const chunks: string[] = [];

  for (const paragraph of paragraphs) {
    if (paragraph.length <= MAX_CHUNK_LENGTH) {
      chunks.push(paragraph.trim());
      continue;
    }

    // Split long paragraphs by sentences
    const sentences = splitSentences(paragraph);
    let current: string[] = [];

    for (const sentence of sentences) {
      current.push(sentence);
      if (current.length >= MAX_CHUNK_SENTENCES || current.join(' ').length > MAX_CHUNK_LENGTH) {
        chunks.push(current.join(' ').trim());
        current = [];
      }
    }
    if (current.length > 0) {
      chunks.push(current.join(' ').trim());
    }
  }

  return chunks;
}

function splitSentences(text: string): string[] {
  // Split on sentence boundaries across scripts:
  // Latin/Cyrillic/Greek: . ! ? … ‽
  // Chinese/Japanese: 。！？
  // Arabic/Urdu: ؟ ؛
  // Greek ano teleia: ·
  // Thai: ฯ
  // Ethiopic: ። ፤
  // Armenian: ։
  // Devanagari: ।
  return text
    .split(/(?<=[.!?…‽。！？؟؛·ฯ።፤։।])\s*/)
    .filter(s => s.trim().length > 0);
}

function classifyChunk(text: string): NodeType {
  const lower = text.toLowerCase();

  // Definition patterns (multilingual)
  if (text.length < 200 && new RegExp([
    // English
    'is defined as', 'refers to', 'is a\\b', 'is an\\b', '\\bmeans\\b',
    // French
    'est défini comme', 'se réfère à', 'est un\\b', 'est une\\b', 'signifie',
    // Spanish
    'se define como', 'se refiere a', 'es un\\b', 'es una\\b', 'significa',
    // German
    'wird definiert als', 'bezieht sich auf', 'ist ein\\b', 'ist eine\\b', 'bedeutet',
    // Italian
    'è definito come', 'si riferisce a', 'è un\\b', 'è una\\b',
    // Portuguese
    'é definido como', 'refere-se a', 'é um\\b', 'é uma\\b',
    // Romanian
    'este definit ca', 'se referă la', 'este un\\b', 'este o\\b', 'înseamnă',
    // Russian
    'определяется как', 'относится к', 'означает', 'является',
    // Turkish
    'olarak tanımlanır', 'anlamına gelir',
    // Arabic
    'يُعرَّف بأنه', 'يشير إلى', 'يعني',
    // Japanese
    'とは', 'と定義される', 'を意味する',
    // Chinese
    '定义为', '是指', '意味着', '被定义为',
    // Korean
    '정의된다', '의미한다', '가리킨다',
  ].join('|'), 'i').test(lower)) {
    return 'definition';
  }

  // Event patterns (dates, years — multilingual)
  if (new RegExp([
    // Universal date patterns
    'in \\d{4}', 'on \\w+ \\d{1,2}', '\\d{1,2}[./]\\d{1,2}[./]\\d{2,4}',
    // English
    'founded', 'invented', 'created', 'launched', 'discovered',
    // French
    'fondé', 'inventé', 'créé', 'lancé', 'découvert',
    // Spanish
    'fundado', 'inventado', 'creado', 'lanzado', 'descubierto',
    // German
    'gegründet', 'erfunden', 'geschaffen', 'gestartet', 'entdeckt',
    // Italian
    'fondato', 'inventato', 'creato', 'lanciato', 'scoperto',
    // Portuguese
    'fundado', 'inventado', 'criado', 'lançado', 'descoberto',
    // Romanian
    'fondat', 'inventat', 'creat', 'lansat', 'descoperit',
    // Russian
    'основан', 'изобретён', 'создан', 'запущен', 'обнаружен',
    // Japanese
    '設立', '発明', '創設', '発見', '年に',
    // Chinese
    '成立于', '发明', '创建', '发现', '年',
    // Korean
    '설립', '발명', '창설', '발견',
    // Arabic
    'تأسست', 'اختُرع', 'أُنشئ', 'اكتُشف',
    // Turkish
    'kuruldu', 'icat edildi', 'oluşturuldu', 'keşfedildi',
  ].join('|'), 'i').test(lower)) {
    return 'event';
  }

  // Data point patterns (universal — numbers, percentages, currencies)
  if (/(?:\d+%|[$€£¥₹₽₩₺][\d,.]+|[\d,.]+\s*(?:million|billion|thousand|milliard|millón|millones|milhão|millions|milliards|миллион|миллиард|万|亿|백만|십억))/i.test(lower)) {
    return 'data-point';
  }

  // Claim patterns (multilingual)
  if (new RegExp([
    // English
    'according to', 'studies show', 'research suggests', 'it is believed',
    // French
    'selon', 'les études montrent', 'la recherche suggère', 'on croit que',
    // Spanish
    'según', 'los estudios muestran', 'la investigación sugiere', 'se cree que',
    // German
    'laut', 'studien zeigen', 'forschung deutet', 'es wird angenommen',
    // Italian
    'secondo', 'gli studi dimostrano', 'la ricerca suggerisce', 'si ritiene',
    // Portuguese
    'de acordo com', 'estudos mostram', 'a pesquisa sugere', 'acredita-se',
    // Romanian
    'conform', 'studiile arată', 'cercetarea sugerează', 'se crede că',
    // Russian
    'согласно', 'исследования показывают', 'считается что',
    // Turkish
    'araştırmalar gösteriyor', 'göre',
    // Arabic
    'وفقًا لـ', 'تشير الدراسات', 'يُعتقد أن',
    // Japanese
    'によると', '研究によれば', 'とされている',
    // Chinese
    '根据', '研究表明', '据信',
    // Korean
    '에 따르면', '연구에 의하면', '것으로 여겨진다',
  ].join('|'), 'i').test(lower)) {
    return 'claim';
  }

  return 'fact';
}

function extractLinks(text: string): string[] {
  const links: string[] = [];

  // Markdown links: [text](url)
  const mdLinks = text.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g);
  for (const match of mdLinks) {
    links.push(match[2]);
  }

  // Wiki-style links: [[article]]
  const wikiLinks = text.matchAll(/\[\[([^\]]+)\]\]/g);
  for (const match of wikiLinks) {
    links.push(match[1]);
  }

  return links;
}
