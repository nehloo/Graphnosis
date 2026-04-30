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

  // Split on conjunctions and prepositions (multilingual)
  const clauses = question.split(new RegExp([
    // English
    '\\b(?:and|or|but|how|why|when|where|what|which|between|from|with)\\b',
    // French
    '\\b(?:et|ou|mais|comment|pourquoi|quand|où|entre|avec)\\b',
    // Spanish
    '\\b(?:y|o|pero|cómo|por qué|cuándo|dónde|entre|con)\\b',
    // German
    '\\b(?:und|oder|aber|wie|warum|wann|wo|zwischen|mit)\\b',
    // Italian
    '\\b(?:e|o|ma|come|perché|quando|dove|tra|con)\\b',
    // Portuguese
    '\\b(?:e|ou|mas|como|por que|quando|onde|entre|com)\\b',
    // Romanian
    '\\b(?:și|sau|dar|cum|de ce|când|unde|între|cu)\\b',
    // Russian
    '\\b(?:и|или|но|как|почему|когда|где|между|с)\\b',
    // Turkish
    '\\b(?:ve|veya|ama|nasıl|neden|ne zaman|nerede|arasında|ile)\\b',
  ].join('|'), 'iu'))
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

  // Capitalized multi-word phrases (Unicode-aware — handles accented, Cyrillic, Greek, etc.)
  const capitalizedMatches = text.matchAll(/(\p{Lu}\p{Ll}+(?:\s+\p{Lu}\p{Ll}+)*)/gu);
  for (const match of capitalizedMatches) {
    if (match[1].split(' ').length >= 1) {
      phrases.push(match[1]);
    }
  }

  // Quoted phrases (multiple quote styles: straight, curly, guillemets, CJK)
  const quotedMatches = text.matchAll(/"([^"]+)"|'([^']+)'|«([^»]+)»|„([^"]+)"|「([^」]+)」|『([^』]+)』|"([^"]+)"/g);
  for (const match of quotedMatches) {
    const term = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? match[6] ?? match[7];
    if (term) phrases.push(term);
  }

  // Technical terms / acronyms (Unicode uppercase sequences)
  const techMatches = text.matchAll(/\b(\p{Lu}{2,}(?:\s+\p{Lu}{2,})*)\b/gu);
  for (const match of techMatches) {
    phrases.push(match[1]);
  }

  // CJK character sequences (2+ chars — likely entity names)
  const cjkMatches = text.matchAll(/([\u4E00-\u9FFF\u3400-\u4DBF\uAC00-\uD7AF]{2,})/g);
  for (const match of cjkMatches) {
    phrases.push(match[1]);
  }

  return phrases;
}

function extractActionConcept(question: string): string | null {
  // Map question patterns to search concepts (multilingual)
  // Each regex combines patterns across languages for the same concept
  const patterns: Array<{ regex: RegExp; concept: string }> = [
    // Influence/impact
    { regex: /(?:influence|affect|impact|change|shape|influencer|affecter|influir|afectar|beeinflussen|influenzare|influenciar|influența|влиять|etkilemek)/i, concept: 'influence impact effect' },
    // Relationship
    { regex: /(?:relationship between|relation entre|relación entre|Beziehung zwischen|relazione tra|relação entre|relația dintre|связь между|ilișki arasında|関係|关系|관계)/i, concept: 'relationship connection link' },
    // Comparison
    { regex: /(?:compare|difference|similar|comparer|différence|similaire|comparar|diferencia|vergleichen|Unterschied|confrontare|differenza|comparar|diferença|compara|diferență|сравнить|различие|karşılaştır|fark|比較|比较|비교)/i, concept: 'comparison difference similarity' },
    // Cause/reason
    { regex: /(?:cause|reason|why|pourquoi|raison|por qué|razón|warum|Grund|perché|ragione|por que|razão|de ce|motiv|почему|причина|neden|sebep|なぜ|原因|为什么|왜|이유)/i, concept: 'cause reason explanation' },
    // History/timeline
    { regex: /(?:timeline|history|evolution|develop|histoire|évolution|historia|evolución|Geschichte|Entwicklung|storia|evoluzione|história|evolução|istorie|evoluție|история|эволюция|tarih|gelișim|歴史|進化|历史|进化|역사|발전)/i, concept: 'history development timeline evolution' },
    // Invention/creation
    { regex: /(?:invented|created|designed|built|inventé|créé|conçu|inventado|creado|erfunden|geschaffen|inventato|creato|inventado|criado|inventat|creat|изобретён|создан|icat edildi|oluşturuldu|発明|創造|发明|创造|발명|창조)/i, concept: 'invention creation design' },
  ];

  for (const { regex, concept } of patterns) {
    if (regex.test(question)) return concept;
  }

  return null;
}
