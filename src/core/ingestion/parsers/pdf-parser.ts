import { PDFParse } from 'pdf-parse';
import type { ParsedDocument, ParsedSection } from '@/core/types';

// pdf-parse v2 is a class-based API (rewrite from the v1 callable form).
// Supports both ESM and CJS; we import it natively. The parser must be
// .destroy()'d to release the underlying worker.
export async function parsePdf(buffer: Buffer, sourceFile: string): Promise<ParsedDocument> {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });

  try {
    const [textResult, infoResult] = await Promise.all([
      parser.getText(),
      parser.getInfo(),
    ]);
    const text = textResult.text || '';
    const sections = splitPdfIntoSections(text);

    // pdf-parse v2 surfaces page count on `total` and the PDF "Info" dict on
    // `info` (typical fields: Title, Author, Subject, Creator, Producer, dates).
    const infoDict = (infoResult.info ?? {}) as Record<string, string | undefined>;
    return {
      title: infoDict.Title || sourceFile.replace(/\.pdf$/i, ''),
      sections,
      sourceFile,
      metadata: {
        pageCount: infoResult.total || 0,
        author: infoDict.Author || '',
        source: 'pdf',
      },
    };
  } finally {
    await parser.destroy();
  }
}

function splitPdfIntoSections(text: string): ParsedSection[] {
  const lines = text.split('\n');
  const sections: ParsedSection[] = [];
  let currentSection: ParsedSection | null = null;
  let contentLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Heuristic: lines that are short, capitalized, or numbered are likely section headers.
    // Unicode-aware: \p{Lu} matches uppercase in Latin, Cyrillic, Greek, Armenian, etc.
    const isHeader =
      (trimmed.length < 80 && /^\p{Lu}/u.test(trimmed) && !trimmed.endsWith('.') && !trimmed.endsWith('。')) ||
      /^\d+\.?\s+\p{Lu}/u.test(trimmed) ||
      /^(abstract|introduction|conclusion|references|related work|methodology|results|discussion|acknowledgments|résumé|введение|заключение|литература|bibliographie|bibliografía|einleitung|schlussfolgerung|literaturverzeichnis|introdução|conclusão|referências|introducere|concluzii|bibliografie|要旨|はじめに|結論|参考文献|摘要|引言|结论|参考文献|서론|결론|참고문헌)/i.test(trimmed);

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
