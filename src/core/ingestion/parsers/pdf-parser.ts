import { extractText, getDocumentProxy, getMeta } from 'unpdf';
import type { ParsedDocument, ParsedSection } from '@/core/types';

// unpdf wraps pdfjs-dist for serverless/Node runtimes — same upstream
// engine as pdf-parse@2.x but configured to avoid the LoopbackPort
// structuredClone failure path that breaks pdf-parse@2 in Node. Replaces
// pdf-parse as of SDK 0.4.0; chosen over alternatives (pdfreader,
// pdf2json, mupdf-js) because it preserves pdfjs-quality text
// extraction with the smallest API/output drift.
export async function parsePdf(buffer: Buffer, sourceFile: string): Promise<ParsedDocument> {
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text, totalPages } = await extractText(pdf, { mergePages: true });
  const fullText = Array.isArray(text) ? text.join('\n') : text;
  const sections = splitPdfIntoSections(fullText);

  // unpdf's getMeta surfaces the same Info dict pdfjs exposes — Title,
  // Author, Subject, Creator, Producer, dates. Wrapped in a try because
  // some PDFs have malformed/missing metadata blocks.
  let title = sourceFile.replace(/\.pdf$/i, '');
  let author = '';
  try {
    const meta = await getMeta(pdf);
    const info = (meta.info ?? {}) as Record<string, string | undefined>;
    if (info.Title && info.Title.trim()) title = info.Title;
    if (info.Author && info.Author.trim()) author = info.Author;
  } catch {
    // Non-fatal — fall back to filename for title, empty for author.
  }

  return {
    title,
    sections,
    sourceFile,
    metadata: {
      pageCount: totalPages || 0,
      author,
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
