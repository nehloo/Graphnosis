import { getDocumentProxy, getMeta } from 'unpdf';
import type { ParsedDocument, ParsedSection } from '@/core/types';

interface PdfTextItem {
  str: string;
  transform: number[]; // [scaleX, shearY, shearX, scaleY, x, y]
  width: number;
  hasEOL: boolean;
}

/**
 * Join pdfjs TextItems into a string using position-aware spacing.
 *
 * Blindly joining with ' ' splits words in PDFs where each glyph is a
 * separate item (common in Eastern European and other diacritic-heavy PDFs).
 * Instead, we compute the gap between consecutive items and only insert a
 * space when it exceeds a fraction of the current font size.  After joining
 * we run NFC normalization so combining diacritic sequences ('a' + '̆')
 * collapse into precomposed forms ('ă').
 */
function joinPdfItems(items: PdfTextItem[]): string {
  let text = '';
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item.str) continue;
    text += item.str;
    if (i < items.length - 1) {
      const next = items[i + 1];
      if (!next?.str) continue;
      if (item.hasEOL) {
        text += '\n';
      } else {
        // transform[4] is the x origin of the item; width is in the same units.
        const gap = next.transform[4] - (item.transform[4] + item.width);
        // font size ≈ absolute value of the y-scale component (transform[3])
        const fontSize = Math.abs(item.transform[3]) || 10;
        if (gap > fontSize * 0.2) text += ' ';
        // gap ≤ threshold → adjacent glyphs, concatenate without space
      }
    }
  }
  // Collapse decomposed diacritic sequences into precomposed Unicode forms.
  return text.normalize('NFC');
}

// Pages extracted per batch. Each batch is a Promise.all that blocks the
// event loop until all pages in it are rendered — keep this small so the
// sidecar stays responsive between batches.
const PAGE_BATCH_SIZE = 10;

export interface ParsePdfOptions {
  /**
   * Hard cap on pages extracted. Documents longer than this get truncated
   * with a `[Note: …]` line appended to the parsed text, and the
   * resulting `ParsedDocument.metadata.truncated` is set to 1.
   *
   * Default: `Infinity` (no cap). pdfjs-dist with the batched extraction
   * below handles very large PDFs without OOM in normal Node memory
   * envelopes; the cap exists for callers that want hard latency / memory
   * bounds (e.g. serverless functions, multi-tenant ingesters where one
   * user's 4233-page manual shouldn't bottleneck everyone else).
   */
  maxPages?: number;
}

// unpdf wraps pdfjs-dist for serverless/Node runtimes — same upstream
// engine as pdf-parse@2.x but configured to avoid the LoopbackPort
// structuredClone failure path that breaks pdf-parse@2 in Node. Replaces
// pdf-parse as of SDK 0.4.0; chosen over alternatives (pdfreader,
// pdf2json, mupdf-js) because it preserves pdfjs-quality text
// extraction with the smallest API/output drift.
export async function parsePdf(
  buffer: Buffer,
  sourceFile: string,
  opts: ParsePdfOptions = {},
): Promise<ParsedDocument> {
  const maxPages = opts.maxPages ?? Infinity;
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const totalPages = pdf.numPages;
  const pagesToExtract = Math.min(totalPages, maxPages);
  const truncated = totalPages > maxPages;

  // Extract text page-by-page in small batches to bound peak memory.
  // Doing all pages via Promise.all on a 1000-page PDF causes OOM/timeout.
  // yield between batches so the sidecar event loop stays responsive.
  const yieldToLoop = () => new Promise<void>((r) => setImmediate(r));
  const pageTexts: string[] = [];
  for (let start = 1; start <= pagesToExtract; start += PAGE_BATCH_SIZE) {
    const end = Math.min(start + PAGE_BATCH_SIZE - 1, pagesToExtract);
    const batch = await Promise.all(
      Array.from({ length: end - start + 1 }, async (_, i) => {
        const page = await pdf.getPage(start + i);
        const content = await page.getTextContent();
        return joinPdfItems(content.items as PdfTextItem[]);
      })
    );
    pageTexts.push(...batch);
    await yieldToLoop();
  }

  let fullText = pageTexts.join('\n');
  if (truncated) {
    fullText += `\n\n[Note: This PDF has ${totalPages} pages. Only the first ${pagesToExtract} pages were ingested.]`;
  }

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
      pageCount: totalPages,
      pagesIngested: pagesToExtract,
      truncated: truncated ? 1 : 0,
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
