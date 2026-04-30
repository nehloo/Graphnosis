// Pluggable text analyzer for TF-IDF tokenization.
//
// Graphnosis ships two built-in analyzers. Custom analyzers (Snowball
// stemmers, language-specific Zemberek/Hunspell, etc.) implement the
// `TextAnalyzer` interface and live in user code or in a future
// `@nehloo/graphnosis-langs` companion package.
//
//   - `asciiFoldAnalyzer`  (default) — diacritic-folded ASCII
//                                      tokenization. `café` and `cafe`
//                                      collapse to the same token.
//                                      Works for English plus Latin-
//                                      script proper names and mixed-
//                                      language corpora where folded
//                                      tokens are acceptable.
//
//   - `unicodeAnalyzer`    — Unicode-aware, diacritic-preserving,
//                            no stopwords. Use for Turkish (`ı` ≠ `i`),
//                            languages with phonemic diacritics, or
//                            anywhere folding loses meaning.
//
// Choosing the wrong analyzer is silently quality-degrading, not loud,
// so the analyzer's `id` is persisted on the graph metadata and
// load-time mismatches throw `AnalyzerMismatchError`.

import { STOPWORDS, STOPWORDS_BY_LANG } from '@/core/constants';

export interface TextAnalyzer {
  /**
   * Stable identifier — persisted on `IndexProvenance.adapterId` and
   * `GraphMetadata.analyzerAdapterId`. Two analyzers with the same `id`
   * MUST produce token streams compatible for cross-comparison. Loading
   * a graph saved with one analyzer against a runtime configured with a
   * different `id` triggers `AnalyzerMismatchError`.
   */
  id: string;
  /** Lower-case + tokenize a string. The stopword filter is applied after this. */
  tokenize(text: string): string[];
  /** Optional. If absent, no stopword filtering is applied. */
  stopwords?: Set<string>;
}

/**
 * Diacritic-folded ASCII analyzer. The default.
 *
 * Pipeline:
 *   1. Lowercase.
 *   2. Unicode NFD-normalize and strip combining marks (`café` → `cafe`,
 *      `cusătură` → `cusatura`, `Łódź` → `lódz` → `lodz`).
 *   3. Replace any remaining non-ASCII alphanumerics with whitespace.
 *   4. Split on whitespace, drop tokens shorter than 2 chars.
 *   5. Remove English stopwords.
 *
 * Good for: English documents (handles `café` / `cafe` matching for
 * free), Latin-script proper names, mixed-language corpora where
 * losing diacritic distinctions is acceptable.
 *
 * Bad for: languages where diacritics carry phonemic meaning. Turkish
 * `kız` vs `kiz` are different words; German `Müller` ≠ `Mueller`.
 * Use `unicodeAnalyzer` for those.
 */
export const asciiFoldAnalyzer: TextAnalyzer = {
  id: 'ascii-fold',
  stopwords: STOPWORDS,
  tokenize(text: string): string[] {
    return text
      .toLowerCase()
      // NFD + strip combining marks: ă→a, é→e, ñ→n, etc.
      .normalize('NFD')
      // Strip combining diacritical marks (U+0300 – U+036F).
      .replace(/[̀-ͯ]/g, '')
      // Anything still non-ASCII alphanumeric becomes a separator.
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 1);
  },
};

/**
 * Unicode-aware analyzer. Splits on runs of Unicode letters / numbers /
 * combining marks, lowercases, preserves diacritics. No stopword
 * filtering by default — different languages have different stopword
 * sets, and applying English stopwords to (e.g.) Romanian text would
 * drop important content.
 *
 * Use this for any corpus where diacritics carry meaning. The textbook
 * cases:
 *   - Turkish: `ı` ≠ `i`, `ğ` ≠ `g`, `ş` ≠ `s` are distinct phonemes.
 *   - Hungarian: vowel length distinctions (`a` ≠ `á`, `o` ≠ `ó`).
 *   - Finnish: `ä` ≠ `a`, `ö` ≠ `o`.
 *   - German: `Müller` and `Mueller` are *both* valid spellings —
 *     folding loses one direction; expansion (`ü` → `ue`) needs a
 *     real morphological analyzer.
 *
 * To add a stopword set for a specific language, wrap this analyzer:
 *
 *   const roAnalyzer: TextAnalyzer = {
 *     ...unicodeAnalyzer,
 *     id: 'unicode-ro',
 *     stopwords: ROMANIAN_STOPWORDS,
 *   };
 */
export const unicodeAnalyzer: TextAnalyzer = {
  id: 'unicode',
  tokenize(text: string): string[] {
    const matches = text.toLowerCase().match(/[\p{L}\p{N}\p{M}]+/gu);
    if (!matches) return [];
    return matches.filter(t => t.length > 1);
  },
};

/**
 * Create a locale-aware analyzer with language-specific stopwords.
 *
 * Uses Unicode tokenization (diacritic-preserving) with the stopword
 * set for the given language code. Falls back to the combined set for
 * unknown languages.
 *
 *   const roAnalyzer = createLocaleAnalyzer('ro');
 *   const deAnalyzer = createLocaleAnalyzer('de');
 */
export function createLocaleAnalyzer(lang: string): TextAnalyzer {
  const stopwords = STOPWORDS_BY_LANG[lang] ?? STOPWORDS;
  return {
    id: `unicode-${lang}`,
    stopwords,
    tokenize(text: string): string[] {
      // Use locale-aware lowercasing (handles Turkish İ→i, ı→ı correctly)
      const lower = text.toLocaleLowerCase(lang);
      const matches = lower.match(/[\p{L}\p{N}\p{M}]+/gu);
      if (!matches) return [];
      return matches.filter(t => t.length > 1);
    },
  };
}
