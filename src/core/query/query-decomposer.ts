// Decompose complex questions into sub-queries for better graph coverage
// "How did Boolean algebra influence programming languages?" becomes:
// 1. "Boolean algebra"
// 2. "programming languages"
// 3. "influence impact development"

export interface DecomposedQuery {
  original: string;
  subQueries: string[];
}

export function decomposeQuery(question: string): DecomposedQuery {
  const subQueries: string[] = [question]; // Always include original

  // Extract noun phrases (capitalized multi-word or quoted terms)
  const nounPhrases = extractNounPhrases(question);
  for (const phrase of nounPhrases) {
    if (phrase.toLowerCase() !== question.toLowerCase()) {
      subQueries.push(phrase);
    }
  }

  // Extract relationship/action words
  const actionWords = extractActionConcept(question);
  if (actionWords) {
    subQueries.push(actionWords);
  }

  // Split on conjunctions and prepositions
  const clauses = question.split(/\b(?:and|or|but|how|why|when|where|what|which|between|from|with)\b/i)
    .map(s => s.trim())
    .filter(s => s.length > 10);

  for (const clause of clauses) {
    if (!subQueries.includes(clause)) {
      subQueries.push(clause);
    }
  }

  // Deduplicate and limit
  const unique = [...new Set(subQueries)].slice(0, 6);

  return {
    original: question,
    subQueries: unique,
  };
}

function extractNounPhrases(text: string): string[] {
  const phrases: string[] = [];

  // Capitalized multi-word phrases
  const capitalizedMatches = text.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/g);
  for (const match of capitalizedMatches) {
    if (match[1].split(' ').length >= 1) {
      phrases.push(match[1]);
    }
  }

  // Quoted phrases
  const quotedMatches = text.matchAll(/"([^"]+)"|'([^']+)'/g);
  for (const match of quotedMatches) {
    phrases.push(match[1] || match[2]);
  }

  // Technical terms (words with special characters or specific patterns)
  const techMatches = text.matchAll(/\b([A-Z]{2,}(?:\s+[A-Z]{2,})*)\b/g);
  for (const match of techMatches) {
    phrases.push(match[1]);
  }

  return phrases;
}

function extractActionConcept(question: string): string | null {
  // Map question patterns to search concepts
  const patterns: Array<{ regex: RegExp; concept: string }> = [
    { regex: /how\s+did\s+(.+?)\s+(?:influence|affect|impact|change|shape)/i, concept: 'influence impact effect' },
    { regex: /what\s+is\s+the\s+relationship\s+between/i, concept: 'relationship connection link' },
    { regex: /(?:compare|difference|similar)/i, concept: 'comparison difference similarity' },
    { regex: /(?:cause|reason|why)/i, concept: 'cause reason explanation' },
    { regex: /(?:timeline|history|evolution|develop)/i, concept: 'history development timeline evolution' },
    { regex: /(?:invented|created|designed|built)/i, concept: 'invention creation design' },
  ];

  for (const { regex, concept } of patterns) {
    if (regex.test(question)) return concept;
  }

  return null;
}
