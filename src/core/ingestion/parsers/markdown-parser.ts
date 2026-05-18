import type { ParsedDocument, ParsedSection } from '@/core/types';

export function parseMarkdown(content: string, sourceFile: string): ParsedDocument {
  const lines = content.split('\n');
  const title = extractTitle(lines);
  const sections = buildSectionTree(lines);
  const metadata = extractFrontmatter(content);

  // Headerless-content fallback: if the input is non-empty prose but has
  // no `#` heading anywhere, `buildSectionTree` returns an empty array
  // because it only attaches content lines to an open section. That made
  // the chunker emit zero content nodes and the caller's `appendMarkdown`
  // looked like a no-op — biting MCP `remember` callers that pass plain
  // prose without a synthetic header (a common AI-client shape).
  //
  // When sections is empty AND the body (post-frontmatter) has non-whitespace
  // content, wrap the whole thing in a single synthetic section so the
  // chunker has something to work with. The section's title falls back to
  // the resolved document title ('Untitled' when no `#` exists) — the
  // chunker uses it to label a section node, which downstream consumers
  // can spot and treat as a placeholder.
  if (sections.length === 0) {
    const bodyWithoutFrontmatter = content.replace(/^---\n[\s\S]*?\n---\n?/, '');
    if (bodyWithoutFrontmatter.trim().length > 0) {
      sections.push({
        title,
        content: bodyWithoutFrontmatter.trim(),
        depth: 1,
        children: [],
      });
    }
  }

  return {
    title,
    sections,
    sourceFile,
    metadata,
  };
}

function extractTitle(lines: string[]): string {
  for (const line of lines) {
    const match = line.match(/^#\s+(.+)/);
    if (match) return match[1].trim();
  }
  return 'Untitled';
}

function extractFrontmatter(content: string): Record<string, string | number> {
  const metadata: Record<string, string | number> = {};
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return metadata;

  for (const line of match[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.+)/);
    if (kv) {
      const val = kv[2].trim();
      metadata[kv[1]] = isNaN(Number(val)) ? val : Number(val);
    }
  }
  return metadata;
}

interface RawSection {
  title: string;
  depth: number;
  contentLines: string[];
  children: RawSection[];
}

function buildSectionTree(lines: string[]): ParsedSection[] {
  const root: RawSection[] = [];
  const stack: RawSection[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      const depth = headingMatch[1].length;
      const section: RawSection = {
        title: headingMatch[2].trim(),
        depth,
        contentLines: [],
        children: [],
      };

      // Find parent: pop stack until we find a shallower section
      while (stack.length > 0 && stack[stack.length - 1].depth >= depth) {
        stack.pop();
      }

      if (stack.length === 0) {
        root.push(section);
      } else {
        stack[stack.length - 1].children.push(section);
      }
      stack.push(section);
    } else if (stack.length > 0) {
      stack[stack.length - 1].contentLines.push(line);
    }
  }

  return root.map(toSection);
}

function toSection(raw: RawSection): ParsedSection {
  return {
    title: raw.title,
    content: raw.contentLines.join('\n').trim(),
    depth: raw.depth,
    children: raw.children.map(toSection),
  };
}
