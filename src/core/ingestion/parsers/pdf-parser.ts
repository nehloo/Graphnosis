import { createRequire } from 'node:module';
import type { ParsedDocument, ParsedSection } from '@/core/types';

// `pdf-parse` is CJS-only, so we have to load it via createRequire from this
// ESM module. A bare `require()` here throws `ReferenceError: require is not
// defined` when the package is consumed from an ESM project.
const require = createRequire(import.meta.url);

// Dynamic import pdf-parse at runtime (it uses Node.js fs)
export async function parsePdf(buffer: Buffer, sourceFile: string): Promise<ParsedDocument> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pdfParse = require('pdf-parse') as (buf: Buffer) => Promise<{ text: string; numpages: number; info: Record<string, string> }>;
  const data = await pdfParse(buffer);

  const text = data.text || '';
  const sections = splitPdfIntoSections(text);

  return {
    title: data.info?.Title || sourceFile.replace(/\.pdf$/i, ''),
    sections,
    sourceFile,
    metadata: {
      pageCount: data.numpages || 0,
      author: data.info?.Author || '',
      source: 'pdf',
    },
  };
}

function splitPdfIntoSections(text: string): ParsedSection[] {
  const lines = text.split('\n');
  const sections: ParsedSection[] = [];
  let currentSection: ParsedSection | null = null;
  let contentLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Heuristic: lines that are short, capitalized, or numbered are likely section headers
    // Unicode-aware: \p{Lu} matches uppercase in Latin, Cyrillic, Greek, Armenian, etc.
    const isHeader = (
      (trimmed.length < 80 && /^\p{Lu}/u.test(trimmed) && !trimmed.endsWith('.') && !trimmed.endsWith('。')) ||
      /^\d+\.?\s+\p{Lu}/u.test(trimmed) ||
      /^(abstract|introduction|conclusion|references|related work|methodology|results|discussion|acknowledgments|résumé|введение|заключение|литература|bibliographie|bibliografía|einleitung|schlussfolgerung|literaturverzeichnis|introdução|conclusão|referências|introducere|concluzii|bibliografie|要旨|はじめに|結論|参考文献|摘要|引言|结论|参考文献|서론|결론|참고문헌)/i.test(trimmed)
    );

    if (isHeader && trimmed.length > 2) {
      // Save previous section
      if (currentSection) {
        currentSection.content = contentLines.join('\n').trim();
        if (currentSection.content.length > 0) {
          sections.push(currentSection);
        }
      }
      currentSection = {
        title: trimmed,
        content: '',
        depth: 1,
        children: [],
      };
      contentLines = [];
    } else {
      contentLines.push(trimmed);
    }
  }

  // Save last section
  if (currentSection) {
    currentSection.content = contentLines.join('\n').trim();
    if (currentSection.content.length > 0) {
      sections.push(currentSection);
    }
  } else if (contentLines.length > 0) {
    // No sections detected — treat entire text as one section
    sections.push({
      title: 'Content',
      content: contentLines.join('\n').trim(),
      depth: 1,
      children: [],
    });
  }

  return sections;
}
