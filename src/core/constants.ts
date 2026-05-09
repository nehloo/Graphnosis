// Graphnosis Constants

// .gai file format magic bytes: "GAI" + version 1
// .gai = "Graphnosis AI" — the AI-native knowledge graph format
export const GAI_MAGIC = new Uint8Array([0x47, 0x41, 0x49, 0x01]);
export const GAI_VERSION = 1;

// Similarity thresholds
export const SIMILARITY_THRESHOLD = 0.3; // Minimum cosine similarity for undirected edges
export const DEDUP_THRESHOLD = 0.95; // Near-duplicate detection threshold
export const ENTITY_JACCARD_THRESHOLD = 0.2; // Minimum Jaccard for shares-entity edges

// Graph traversal
export const MAX_TRAVERSAL_HOPS = 3;
export const DECAY_FACTOR = 0.6; // Score decay per hop
export const TOP_K_NODES = 20; // Max nodes in query subgraph
export const SEED_COUNT = 5; // Max seed nodes per query

// Chunking
export const MAX_CHUNK_SENTENCES = 3; // Max sentences per chunk
export const MIN_CHUNK_LENGTH = 20; // Min characters for a valid chunk
export const MAX_CHUNK_LENGTH = 500; // Max characters per chunk

// TF-IDF — Multilingual stopwords
// Per-language sets so the correct filter can be applied based on detected or configured language.
// Combined STOPWORDS set is the union — suitable for mixed-language corpora.

export const STOPWORDS_EN = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
  'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
  'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
  'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then',
  'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'both',
  'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor',
  'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 'just',
  'because', 'but', 'and', 'or', 'if', 'while', 'about', 'up', 'that',
  'this', 'these', 'those', 'it', 'its', 'he', 'she', 'they', 'them',
  'his', 'her', 'their', 'what', 'which', 'who', 'whom', 'we', 'you',
  'i', 'me', 'my', 'your', 'our', 'also', 'however', 'although',
]);

export const STOPWORDS_RO = new Set([
  'și', 'sau', 'dar', 'în', 'la', 'de', 'pe', 'cu', 'din', 'prin',
  'spre', 'pentru', 'ca', 'este', 'sunt', 'a', 'ai', 'al', 'ale',
  'o', 'un', 'una', 'nu', 'da', 'mai', 'sau', 'fie', 'care', 'ce',
  'cum', 'când', 'unde', 'cine', 'acest', 'această', 'acesta', 'aceasta',
  'aceștia', 'acestea', 'acel', 'acea', 'acela', 'aceea', 'el', 'ea',
  'ei', 'ele', 'eu', 'tu', 'noi', 'voi', 'se', 'își', 'ne', 'vă',
  'le', 'lor', 'lui', 'ei', 'meu', 'mea', 'tău', 'ta', 'său', 'sa',
  'nostru', 'noastră', 'vostru', 'voastră', 'ori', 'deci', 'însă',
  'fie', 'nici', 'tot', 'toți', 'toate', 'aici', 'acolo', 'apoi',
  'foarte', 'doar', 'chiar', 'după', 'între', 'peste', 'sub', 'am',
  'are', 'avea', 'fost', 'fi', 'va', 'vom', 'vor', 'ar', 'era', 'eram',
]);

export const STOPWORDS_FR = new Set([
  'le', 'la', 'les', 'un', 'une', 'des', 'de', 'du', 'au', 'aux',
  'et', 'ou', 'mais', 'donc', 'ni', 'car', 'en', 'dans', 'sur', 'sous',
  'par', 'pour', 'avec', 'sans', 'entre', 'vers', 'chez', 'est', 'sont',
  'être', 'avoir', 'fait', 'faire', 'dit', 'dire', 'peut', 'plus',
  'pas', 'ne', 'que', 'qui', 'quoi', 'dont', 'où', 'ce', 'cette',
  'ces', 'mon', 'ma', 'mes', 'ton', 'ta', 'tes', 'son', 'sa', 'ses',
  'notre', 'votre', 'leur', 'leurs', 'nous', 'vous', 'ils', 'elles',
  'il', 'elle', 'je', 'tu', 'on', 'se', 'si', 'tout', 'tous', 'toute',
  'toutes', 'très', 'aussi', 'bien', 'même', 'comme', 'après', 'avant',
  'encore', 'alors', 'quand', 'comment', 'pourquoi', 'ici', 'là',
]);

export const STOPWORDS_DE = new Set([
  'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen',
  'einem', 'einer', 'und', 'oder', 'aber', 'denn', 'weil', 'wenn',
  'dass', 'ob', 'als', 'wie', 'in', 'im', 'an', 'am', 'auf', 'aus',
  'bei', 'mit', 'nach', 'über', 'unter', 'von', 'vor', 'zu', 'zum',
  'zur', 'für', 'durch', 'gegen', 'ohne', 'um', 'bis', 'zwischen',
  'ist', 'sind', 'war', 'waren', 'sein', 'haben', 'hat', 'hatte',
  'wird', 'werden', 'kann', 'nicht', 'kein', 'keine', 'auch', 'noch',
  'schon', 'sehr', 'nur', 'ich', 'du', 'er', 'sie', 'es', 'wir',
  'ihr', 'mein', 'dein', 'sein', 'unser', 'euer', 'was', 'wer',
  'wo', 'wann', 'warum', 'hier', 'dort', 'dann', 'so', 'da', 'doch',
]);

export const STOPWORDS_ES = new Set([
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'de', 'del',
  'en', 'y', 'o', 'pero', 'que', 'como', 'con', 'sin', 'por', 'para',
  'entre', 'hasta', 'desde', 'sobre', 'bajo', 'es', 'son', 'ser',
  'estar', 'ha', 'hay', 'fue', 'tiene', 'puede', 'más', 'muy', 'no',
  'ya', 'se', 'su', 'sus', 'este', 'esta', 'estos', 'estas', 'ese',
  'esa', 'esos', 'esas', 'aquel', 'aquella', 'yo', 'tú', 'él', 'ella',
  'nosotros', 'ellos', 'ellas', 'mi', 'tu', 'todo', 'todos', 'toda',
  'todas', 'otro', 'otra', 'cada', 'aquí', 'ahí', 'allí', 'ahora',
  'también', 'donde', 'cuando', 'quien', 'cual', 'porque', 'aunque',
]);

export const STOPWORDS_IT = new Set([
  'il', 'lo', 'la', 'i', 'gli', 'le', 'un', 'uno', 'una', 'di', 'del',
  'dello', 'della', 'dei', 'degli', 'delle', 'in', 'e', 'o', 'ma',
  'che', 'come', 'con', 'per', 'tra', 'fra', 'su', 'da', 'è', 'sono',
  'essere', 'avere', 'ha', 'fatto', 'può', 'più', 'non', 'se', 'si',
  'questo', 'questa', 'questi', 'queste', 'quello', 'quella', 'io',
  'tu', 'lui', 'lei', 'noi', 'voi', 'loro', 'mio', 'tuo', 'suo',
  'nostro', 'vostro', 'ogni', 'tutto', 'tutti', 'anche', 'ancora',
  'sempre', 'dove', 'quando', 'chi', 'quale', 'perché', 'molto',
]);

export const STOPWORDS_PT = new Set([
  'o', 'a', 'os', 'as', 'um', 'uma', 'uns', 'umas', 'de', 'do', 'da',
  'dos', 'das', 'em', 'no', 'na', 'nos', 'nas', 'e', 'ou', 'mas',
  'que', 'como', 'com', 'sem', 'por', 'para', 'entre', 'até', 'desde',
  'sobre', 'sob', 'é', 'são', 'ser', 'estar', 'tem', 'há', 'foi',
  'pode', 'mais', 'muito', 'não', 'se', 'seu', 'sua', 'seus', 'suas',
  'este', 'esta', 'estes', 'estas', 'esse', 'essa', 'eu', 'tu', 'ele',
  'ela', 'nós', 'eles', 'elas', 'meu', 'teu', 'todo', 'todos', 'toda',
  'todas', 'outro', 'outra', 'cada', 'aqui', 'ali', 'agora', 'também',
  'onde', 'quando', 'quem', 'qual', 'porque', 'ainda', 'já',
]);

export const STOPWORDS_NL = new Set([
  'de', 'het', 'een', 'van', 'in', 'en', 'of', 'maar', 'dat', 'die',
  'op', 'aan', 'met', 'voor', 'uit', 'bij', 'naar', 'om', 'door',
  'over', 'na', 'onder', 'tussen', 'tegen', 'is', 'zijn', 'was',
  'waren', 'heeft', 'hebben', 'kan', 'niet', 'ook', 'nog', 'wel',
  'al', 'er', 'ze', 'hij', 'zij', 'wij', 'je', 'ik', 'we', 'mijn',
  'jouw', 'zijn', 'haar', 'ons', 'hun', 'wat', 'wie', 'waar', 'wanneer',
  'waarom', 'hoe', 'hier', 'daar', 'dan', 'zo', 'dit', 'deze', 'meer',
]);

export const STOPWORDS_PL = new Set([
  'i', 'w', 'z', 'na', 'do', 'nie', 'się', 'to', 'jest', 'że', 'o',
  'za', 'co', 'jak', 'ale', 'lub', 'czy', 'po', 'od', 'tak', 'dla',
  'przez', 'przy', 'pod', 'nad', 'przed', 'między', 'ten', 'ta', 'te',
  'tego', 'tej', 'tym', 'tych', 'ich', 'jej', 'jego', 'mój', 'twój',
  'swój', 'nasz', 'wasz', 'ja', 'ty', 'on', 'ona', 'ono', 'my', 'wy',
  'oni', 'one', 'tu', 'tam', 'teraz', 'kiedy', 'gdzie', 'już', 'też',
  'jeszcze', 'tylko', 'bardzo', 'może', 'był', 'była', 'było', 'były',
]);

export const STOPWORDS_RU = new Set([
  'и', 'в', 'на', 'с', 'не', 'что', 'как', 'но', 'или', 'по', 'к',
  'из', 'за', 'от', 'до', 'при', 'для', 'о', 'об', 'у', 'это', 'то',
  'он', 'она', 'оно', 'они', 'мы', 'вы', 'я', 'ты', 'его', 'её',
  'их', 'мой', 'твой', 'свой', 'наш', 'ваш', 'этот', 'тот', 'так��й',
  'все', 'всё', 'весь', 'вся', 'каждый', 'который', 'кто', 'где',
  'когда', 'почему', 'зачем', 'уже', 'ещё', 'тоже', 'также', 'очень',
  'только', 'был', 'была', 'было', 'были', 'есть', 'быть', 'будет',
  'может', 'здесь', 'там', 'тут', 'так', 'да', 'нет', 'же', 'ли',
]);

export const STOPWORDS_TR = new Set([
  've', 'bir', 'bu', 'da', 'de', 'ile', 'için', 'mi', 'mı', 'mu',
  'mü', 'ne', 'o', 'şu', 'ama', 'çok', 'daha', 'var', 'yok', 'ben',
  'sen', 'biz', 'siz', 'onlar', 'benim', 'senin', 'onun', 'bizim',
  'sizin', 'onların', 'gibi', 'kadar', 'sonra', 'önce', 'arasında',
  'üzerinde', 'altında', 'içinde', 'her', 'hiç', 'hem', 'ya', 'ki',
  'olan', 'olarak', 'bile', 'sadece', 'artık', 'nasıl', 'neden',
  'nerede', 'ne zaman', 'burada', 'orada', 'şimdi',
]);

export const STOPWORDS_JA = new Set([
  'の', 'に', 'は', 'を', 'た', 'が', 'で', 'て', 'と', 'し', 'れ',
  'さ', 'ある', 'いる', 'も', 'する', 'から', 'な', 'こと', 'として',
  'い', 'や', 'れる', 'など', 'なっ', 'ない', 'この', 'ため', 'その',
  'あっ', 'よう', 'また', 'もの', 'という', 'あり', 'まで', 'られ',
  'なる', 'へ', 'か', 'だ', 'これ', 'によって', 'により', 'おり',
  'より', 'による', 'ず', 'なり', 'られる', 'において', 'ば', 'なかっ',
  'なく', 'しかし', 'について', 'せ', 'だっ', 'そして', 'できる',
]);

export const STOPWORDS_ZH = new Set([
  '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都',
  '一', '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会',
  '着', '没有', '看', '好', '自己', '这', '他', '她', '它', '们',
  '那', '些', '什么', '怎么', '如何', '为什么', '哪', '哪里', '谁',
  '从', '对', '把', '被', '比', '向', '跟', '与', '给', '用', '而',
  '但', '可以', '能', '将', '还', '可能', '因为', '所以', '如果',
  '虽然', '只', '已经', '非常', '最', '更', '又', '再', '这个', '那个',
]);

export const STOPWORDS_KO = new Set([
  '이', '그', '저', '것', '수', '등', '들', '및', '에', '에서', '의',
  '을', '를', '은', '는', '가', '와', '과', '도', '로', '으로', '에게',
  '한', '하다', '있다', '없다', '되다', '이다', '않다', '그리고', '하지만',
  '또는', '그러나', '그래서', '때문에', '만약', '비록', '아주', '매우',
  '더', '가장', '또', '다시', '이미', '아직', '여기', '거기', '어디',
  '언제', '왜', '어떻게', '무엇', '누구', '어느', '모든', '각', '다른',
]);

export const STOPWORDS_AR = new Set([
  'في', 'من', 'على', 'إلى', 'عن', 'مع', 'هذا', 'هذه', 'ذلك', 'تلك',
  'هو', 'هي', 'هم', 'هن', 'أنا', 'أنت', 'نحن', 'أنتم', 'الذي', 'التي',
  'الذين', 'اللاتي', 'ما', 'ماذا', 'من', 'أين', 'متى', 'لماذا', 'كيف',
  'كل', 'بعض', 'أي', 'كان', 'كانت', 'يكون', 'ليس', 'لا', 'نعم', 'أو',
  'و', 'لكن', 'ثم', 'أيضا', 'فقط', 'جدا', 'قد', 'حتى', 'بين', 'عند',
  'بعد', 'قبل', 'فوق', 'تحت', 'هنا', 'هناك', 'الآن', 'إذا', 'لأن',
]);

export const STOPWORDS_HI = new Set([
  'और', 'का', 'की', 'के', 'में', 'है', 'हैं', 'को', 'से', 'पर',
  'ने', 'यह', 'वह', 'जो', 'कि', 'एक', 'भी', 'नहीं', 'या', 'लेकिन',
  'तो', 'अगर', 'क्योंकि', 'इसलिए', 'बहुत', 'सबसे', 'अधिक', 'कम',
  'कुछ', 'सब', 'हर', 'मैं', 'तुम', 'हम', 'वे', 'उसका', 'उसकी',
  'मेरा', 'मेरी', 'तुम्हारा', 'हमारा', 'उनका', 'क्या', 'कैसे',
  'कहाँ', 'कब', 'क्यों', 'कौन', 'यहाँ', 'वहाँ', 'अभी', 'फिर',
  'अब', 'जब', 'तक', 'बाद', 'पहले', 'बीच', 'ऊपर', 'नीचे', 'साथ',
]);

// Per-language stopword lookup
export const STOPWORDS_BY_LANG: Record<string, Set<string>> = {
  en: STOPWORDS_EN, ro: STOPWORDS_RO, fr: STOPWORDS_FR, de: STOPWORDS_DE,
  es: STOPWORDS_ES, it: STOPWORDS_IT, pt: STOPWORDS_PT, nl: STOPWORDS_NL,
  pl: STOPWORDS_PL, ru: STOPWORDS_RU, tr: STOPWORDS_TR, ja: STOPWORDS_JA,
  zh: STOPWORDS_ZH, ko: STOPWORDS_KO, ar: STOPWORDS_AR, hi: STOPWORDS_HI,
};

// Combined set for mixed-language corpora (backward-compatible default)
export const STOPWORDS = new Set([
  ...STOPWORDS_EN, ...STOPWORDS_RO, ...STOPWORDS_FR, ...STOPWORDS_DE,
  ...STOPWORDS_ES, ...STOPWORDS_IT, ...STOPWORDS_PT, ...STOPWORDS_NL,
  ...STOPWORDS_PL, ...STOPWORDS_RU, ...STOPWORDS_TR, ...STOPWORDS_JA,
  ...STOPWORDS_ZH, ...STOPWORDS_KO, ...STOPWORDS_AR, ...STOPWORDS_HI,
]);

// Pipeline
export const PIPELINE_BATCH_SIZE = 10; // Process files in batches
