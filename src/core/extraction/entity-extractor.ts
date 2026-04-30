// Regex-based Named Entity Recognition (multilingual)
// Extracts: proper nouns, dates, numbers, technical terms, acronyms,
// CJK sequences, quoted/bracketed terms, emails, URLs, hashtags, mentions

export function extractEntities(text: string): string[] {
  const entities = new Set<string>();

  // --- Scripts with capitalization (Latin, Cyrillic, Greek, Armenian, Georgian) ---

  // Multi-word capitalized phrases (e.g., "Alan Turing", "Крас­ная Площадь", "Ελληνική Δημοκρατία")
  const multiWordCap = text.matchAll(
    /(\p{Lu}\p{Ll}+(?:[\s\-]\p{Lu}\p{Ll}+)+)/gu
  );
  for (const match of multiWordCap) {
    entities.add(match[1]);
  }

  // Single capitalized words not at sentence start
  const words = text.split(/\s+/);
  for (let i = 1; i < words.length; i++) {
    const word = words[i].replace(/[^\p{L}]/gu, '');
    if (word.length > 2 && /^\p{Lu}\p{Ll}+$/u.test(word)) {
      if (!COMMON_CAPITALIZED.has(word)) {
        entities.add(word);
      }
    }
  }

  // --- CJK (Chinese, Japanese, Korean) — no capitalization, extract character runs ---

  // Chinese / CJK Unified Ideographs (2+ chars to avoid particles)
  const cjk = text.matchAll(/([\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF]{2,})/g);
  for (const match of cjk) {
    entities.add(match[1]);
  }

  // Japanese Katakana words (often names, loanwords)
  const katakana = text.matchAll(/([\u30A0-\u30FF\u31F0-\u31FF]{2,})/g);
  for (const match of katakana) {
    entities.add(match[1]);
  }

  // Korean Hangul words (2+ syllables)
  const hangul = text.matchAll(/([\uAC00-\uD7AF\u1100-\u11FF]{2,})/g);
  for (const match of hangul) {
    entities.add(match[1]);
  }

  // --- Indic scripts (Hindi, Bengali, Tamil, Telugu, etc.) ---
  // Extract runs of Devanagari, Bengali, Tamil, Telugu, Kannada, Malayalam, Gujarati, Gurmukhi
  const indic = text.matchAll(
    /([\u0900-\u097F\u0980-\u09FF\u0B80-\u0BFF\u0C00-\u0C7F\u0C80-\u0CFF\u0D00-\u0D7F\u0A80-\u0AFF\u0A00-\u0A7F]{2,})/g
  );
  for (const match of indic) {
    entities.add(match[1]);
  }

  // --- Arabic script (Arabic, Persian, Urdu) ---
  const arabic = text.matchAll(/([\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]{2,})/g);
  for (const match of arabic) {
    entities.add(match[1]);
  }

  // --- Hebrew ---
  const hebrew = text.matchAll(/([\u0590-\u05FF\uFB1D-\uFB4F]{2,})/g);
  for (const match of hebrew) {
    entities.add(match[1]);
  }

  // --- Thai ---
  const thai = text.matchAll(/([\u0E00-\u0E7F]{2,})/g);
  for (const match of thai) {
    entities.add(match[1]);
  }

  // --- Georgian (Mkhedruli + Asomtavruli) ---
  const georgian = text.matchAll(/([\u10A0-\u10FF\u2D00-\u2D2F]{2,})/g);
  for (const match of georgian) {
    entities.add(match[1]);
  }

  // --- Ethiopic (Amharic, Tigrinya, etc.) ---
  const ethiopic = text.matchAll(/([\u1200-\u137F\u1380-\u139F]{2,})/g);
  for (const match of ethiopic) {
    entities.add(match[1]);
  }

  // --- Myanmar (Burmese) ---
  const myanmar = text.matchAll(/([\u1000-\u109F]{2,})/g);
  for (const match of myanmar) {
    entities.add(match[1]);
  }

  // --- Khmer (Cambodian) ---
  const khmer = text.matchAll(/([\u1780-\u17FF]{2,})/g);
  for (const match of khmer) {
    entities.add(match[1]);
  }

  // --- Tibetan ---
  const tibetan = text.matchAll(/([\u0F00-\u0FFF]{2,})/g);
  for (const match of tibetan) {
    entities.add(match[1]);
  }

  // --- Sinhala ---
  const sinhala = text.matchAll(/([\u0D80-\u0DFF]{2,})/g);
  for (const match of sinhala) {
    entities.add(match[1]);
  }

  // --- Dates (international formats) ---

  // Years: 1000–2099
  const years = text.matchAll(/\b(1[0-9]{3}|20[0-9]{2})\b/g);
  for (const match of years) {
    entities.add(match[1]);
  }

  // ISO dates: 2024-03-15
  const isoDates = text.matchAll(/\b(\d{4}-\d{2}-\d{2})\b/g);
  for (const match of isoDates) {
    entities.add(match[1]);
  }

  // European dates: 15/03/2024, 15.03.2024
  const euDates = text.matchAll(/\b(\d{1,2}[./]\d{1,2}[./]\d{2,4})\b/g);
  for (const match of euDates) {
    entities.add(match[1]);
  }

  // --- Acronyms (2+ uppercase letters, any script with uppercase) ---
  const acronyms = text.matchAll(/\b(\p{Lu}{2,})\b/gu);
  for (const match of acronyms) {
    if (!COMMON_ACRONYMS_TO_SKIP.has(match[1])) {
      entities.add(match[1]);
    }
  }

  // --- Technical terms ---

  // Backtick-wrapped
  const backtickTerms = text.matchAll(/`([^`]+)`/g);
  for (const match of backtickTerms) {
    entities.add(match[1]);
  }

  // camelCase and PascalCase identifiers
  const camelCase = text.matchAll(/\b([a-z]+(?:[A-Z][a-z]+)+|[A-Z][a-z]+(?:[A-Z][a-z]+)+)\b/g);
  for (const match of camelCase) {
    entities.add(match[1]);
  }

  // dot.notation identifiers (e.g., "module.exports", "java.util.List")
  const dotNotation = text.matchAll(/\b([\w]+(?:\.[\w]+){1,})\b/g);
  for (const match of dotNotation) {
    entities.add(match[1]);
  }

  // --- Quoted terms (double, single, guillemets, CJK quotes) ---
  const quoted = text.matchAll(
    /(?:"([^"]+)"|'([^']+)'|«([^»]+)»|„([^"]+)"|「([^」]+)」|『([^』]+)』|"([^"]+)")/g
  );
  for (const match of quoted) {
    const term = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? match[6] ?? match[7];
    if (term && term.length > 1 && term.length < 100) {
      entities.add(term);
    }
  }

  // --- Bracketed/parenthetical terms (often definitions or aliases) ---
  const bracketed = text.matchAll(/\(([^)]{2,60})\)/g);
  for (const match of bracketed) {
    if (/\p{L}/u.test(match[1])) {
      entities.add(match[1]);
    }
  }

  // --- Emails ---
  const emails = text.matchAll(/\b([\w.+-]+@[\w.-]+\.\w{2,})\b/g);
  for (const match of emails) {
    entities.add(match[1]);
  }

  // --- URLs ---
  const urls = text.matchAll(/\bhttps?:\/\/[^\s<>\"')\]]+/g);
  for (const match of urls) {
    entities.add(match[0]);
  }

  // --- Hashtags and @mentions ---
  const hashtags = text.matchAll(/(?:^|[\s(])([#@][\w\p{L}]{2,})/gu);
  for (const match of hashtags) {
    entities.add(match[1]);
  }

  // --- Numbers with units ---
  const numbersWithUnits = text.matchAll(
    /\b(\d+(?:[.,]\d+)?\s*(?:kg|km|mi|lb|oz|cm|mm|m|ft|in|°[CF]|%|MB|GB|TB|KB|MHz|GHz|kW|MW|ms|μs|ns))\b/g
  );
  for (const match of numbersWithUnits) {
    entities.add(match[1]);
  }

  // --- Currency amounts ---
  const currency = text.matchAll(
    /(?:[$€£¥₹₽₩₺฿])\s?\d+(?:[.,]\d+)*|\b\d+(?:[.,]\d+)*\s?(?:USD|EUR|GBP|JPY|CNY|INR|RUB|KRW|BRL|RON|CHF|SEK|NOK|DKK|PLN|CZK|HUF|TRY|AUD|CAD|NZD)\b/g
  );
  for (const match of currency) {
    entities.add(match[0]);
  }

  return Array.from(entities);
}

const COMMON_CAPITALIZED = new Set([
  // English
  'The', 'This', 'That', 'These', 'Those', 'There', 'Their',
  'They', 'Then', 'When', 'Where', 'What', 'Which', 'While',
  'However', 'Although', 'Because', 'Since', 'After', 'Before',
  'During', 'Between', 'Through', 'About', 'Into', 'From',
  'Over', 'Under', 'Some', 'Many', 'Most', 'Each', 'Every',
  'Both', 'Such', 'Other', 'Another', 'Several', 'Also',
  'Often', 'Sometimes', 'Usually', 'Today', 'Here', 'Now',
  'But', 'And', 'For', 'Not', 'You', 'All', 'Can', 'Had',
  'Her', 'Was', 'One', 'Our', 'Out', 'Are', 'Has', 'His',
  'How', 'Its', 'May', 'New', 'Old', 'See', 'Way', 'Who',
  'Did', 'Get', 'Let', 'Say', 'She', 'Too', 'Use',
  // French
  'Les', 'Des', 'Une', 'Mais', 'Avec', 'Dans', 'Pour', 'Plus',
  'Tout', 'Tous', 'Toute', 'Comme', 'Donc', 'Puis', 'Chez',
  'Sans', 'Sous', 'Vers', 'Après', 'Avant', 'Entre', 'Cette',
  'Leurs', 'Notre', 'Votre', 'Aussi', 'Encore', 'Très',
  // Spanish
  'Los', 'Las', 'Del', 'Por', 'Con', 'Sin', 'Pero', 'Como',
  'Más', 'Muy', 'Cada', 'Todo', 'Toda', 'Todos', 'Esta',
  'Este', 'Estos', 'Sobre', 'Entre', 'Hasta', 'Desde',
  'Aquí', 'Ahora', 'También', 'Otro', 'Otra', 'Otros',
  // Portuguese
  'Dos', 'Das', 'Mas', 'Mais', 'Para', 'Pela', 'Pelo',
  'Isso', 'Isto', 'Aqui', 'Agora', 'Ainda', 'Além',
  // German (careful — German capitalizes all nouns)
  'Und', 'Oder', 'Aber', 'Denn', 'Weil', 'Wenn', 'Dann',
  'Auch', 'Noch', 'Schon', 'Hier', 'Dort', 'Sehr', 'Viel',
  'Alle', 'Jede', 'Jeder', 'Jedes', 'Mein', 'Dein', 'Sein',
  'Ihre', 'Nach', 'Über', 'Unter', 'Zwischen', 'Durch',
  // Italian
  'Gli', 'Dei', 'Del', 'Per', 'Con', 'Non', 'Che', 'Come',
  'Più', 'Ogni', 'Tutto', 'Questa', 'Questo', 'Questi',
  'Anche', 'Ancora', 'Sempre', 'Dopo', 'Prima', 'Tra',
  // Romanian
  'Și', 'Dar', 'Sau', 'Din', 'Prin', 'Spre', 'Peste',
  'Într', 'Aici', 'Acum', 'Apoi', 'Însă', 'Deci', 'Doar',
  'Este', 'Sunt', 'Fost', 'Când', 'Unde', 'Cum', 'Cât',
  'Toate', 'Fiecare', 'Alte', 'Alți', 'Foarte', 'Multe',
  // Dutch
  'Het', 'Een', 'Van', 'Met', 'Voor', 'Niet', 'Maar',
  'Wel', 'Nog', 'Zijn', 'Haar', 'Hier', 'Daar', 'Alle',
  // Polish
  'Ale', 'Lub', 'Czy', 'Jak', 'Dla', 'Nad', 'Pod', 'Przed',
  'Przez', 'Gdzie', 'Kiedy', 'Tutaj', 'Teraz', 'Także',
  // Czech
  'Ale', 'Nebo', 'Jak', 'Pro', 'Nad', 'Pod', 'Před',
  'Kde', 'Kdy', 'Zde', 'Nyní', 'Také', 'Každý',
  // Turkish
  'Bir', 'Ama', 'İle', 'İçin', 'Daha', 'Çok', 'Her',
  'Hem', 'Gibi', 'Bile', 'Ayrıca', 'Burada', 'Şimdi',
  // Swedish/Norwegian/Danish
  'Och', 'Men', 'Med', 'Som', 'Den', 'Det', 'Har', 'Kan',
  'Ska', 'Var', 'Där', 'Här', 'Inte', 'Eller', 'Efter',
  'Også', 'Ikke', 'Eller', 'Etter', 'Denne', 'Disse',
  // Russian (transliterated — for mixed-script text)
  'Это', 'Все', 'Они', 'Где', 'Как', 'Что', 'Или',
  'Его', 'Для', 'При', 'Над', 'Под', 'Без', 'Между',
]);

const COMMON_ACRONYMS_TO_SKIP = new Set([
  'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X',
  'AM', 'PM', 'AD', 'BC', 'CE', 'BCE',
  'VS', 'EG', 'IE', 'OK', 'NA', 'NB', 'PS', 'RE', 'FW',
  'AV', 'DI', 'DO', 'MI', 'FR', 'SA', 'SO', // day abbrevs (DE)
  'LU', 'MA', 'ME', 'JE', 'VE', 'SA', 'DI', // day abbrevs (FR)
]);
