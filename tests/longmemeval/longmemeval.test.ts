// LongMemEval-style benchmark suite for Bignosis
// Tests knowledge retention, recall accuracy, contradiction handling,
// temporal awareness, and cross-source reasoning
//
// Modeled after: https://github.com/xiaowu0162/LongMemEval
// Categories: Single-Session Recall, Multi-Session Recall,
//             Knowledge Update, Temporal Reasoning, Contradiction Detection

import { buildGraph } from '@/core/graph/graph-builder';
import { queryGraph } from '@/core/query/query-engine';
import type { ParsedDocument, KnowledgeGraph, TfidfIndex } from '@/core/types';
import { applyCorrection } from '@/core/corrections/correction-engine';

// Test document factory
function makeDoc(title: string, sections: Array<{ title: string; content: string }>): ParsedDocument {
  return {
    title,
    sections: sections.map(s => ({ ...s, depth: 1, children: [] })),
    sourceFile: `test:${title}`,
    metadata: { source: 'test' },
  };
}

// Score a query: does the subgraph contain nodes with expected keywords?
function queryContains(
  graph: KnowledgeGraph & { tfidfIndex?: TfidfIndex },
  question: string,
  expectedKeywords: string[]
): { found: boolean; matchedKeywords: string[]; totalNodes: number } {
  const tfidfIndex = graph.tfidfIndex;
  if (!tfidfIndex) return { found: false, matchedKeywords: [], totalNodes: 0 };

  const result = queryGraph(graph, tfidfIndex, question);
  const allContent = result.subgraph.nodes.map(n => n.content.toLowerCase()).join(' ');

  const matchedKeywords = expectedKeywords.filter(kw =>
    allContent.includes(kw.toLowerCase())
  );

  return {
    found: matchedKeywords.length >= Math.ceil(expectedKeywords.length * 0.5),
    matchedKeywords,
    totalNodes: result.subgraph.nodes.length,
  };
}

// ============================================================
// Test Category 1: Single-Session Factual Recall
// Can the system retrieve specific facts from ingested content?
// ============================================================

export const singleSessionTests = [
  {
    name: 'SSR-01: Retrieve a specific date',
    docs: [makeDoc('Space Exploration', [
      { title: 'Apollo Program', content: 'The Apollo program was a series of space missions run by NASA. The program successfully landed humans on the Moon and brought them safely back to Earth. The Apollo 11 mission landed on the Moon on July 20, 1969. Neil Armstrong was the first human to walk on the lunar surface. Buzz Aldrin joined him shortly after, while Michael Collins orbited above in the command module.' },
      { title: 'Legacy', content: 'The Apollo missions brought back 842 pounds of lunar samples. The program cost approximately 25.4 billion dollars. Six missions successfully landed on the Moon between 1969 and 1972. The last Apollo mission to the Moon was Apollo 17 in December 1972.' },
    ])],
    question: 'When did Apollo 11 land on the Moon?',
    expectedKeywords: ['1969', 'apollo', 'moon'],
  },
  {
    name: 'SSR-02: Retrieve a person-fact association',
    docs: [makeDoc('Albert Einstein', [
      { title: 'Early Life', content: 'Albert Einstein was born in Ulm, Germany in 1879. He showed an early interest in mathematics and physics. Einstein studied at the Swiss Federal Polytechnic in Zurich, graduating in 1900. He worked at the Swiss Patent Office while developing his revolutionary theories.' },
      { title: 'Scientific Contributions', content: 'Albert Einstein developed the theory of general relativity in 1915, fundamentally changing our understanding of gravity. He was awarded the Nobel Prize in Physics in 1921 for his explanation of the photoelectric effect, not for relativity as many assume. Einstein also contributed to quantum mechanics and statistical mechanics.' },
    ])],
    question: 'What did Einstein win the Nobel Prize for?',
    expectedKeywords: ['photoelectric', 'nobel', 'einstein'],
  },
  {
    name: 'SSR-03: Retrieve a definition',
    docs: [makeDoc('Computation Theory', [
      { title: 'Turing Machine', content: 'A Turing machine is a mathematical model of computation that defines an abstract machine which manipulates symbols on a strip of tape according to a table of rules. Despite its simplicity, a Turing machine can be adapted to simulate the logic of any computer algorithm. The concept was introduced by Alan Turing in 1936.' },
      { title: 'Significance', content: 'The Turing machine provides a precise definition of what it means for a function to be computable. It forms the theoretical foundation of modern computer science. The Church-Turing thesis states that any effectively calculable function can be computed by a Turing machine.' },
    ])],
    question: 'What is a Turing machine?',
    expectedKeywords: ['mathematical', 'model', 'computation', 'tape'],
  },
  {
    name: 'SSR-04: Retrieve a numerical fact',
    docs: [makeDoc('World Geography', [
      { title: 'Mount Everest', content: 'Mount Everest stands at 8,849 meters above sea level, making it the tallest mountain on Earth. It is located in the Himalayan mountain range on the border between Nepal and Tibet. The mountain was first summited by Edmund Hillary and Tenzing Norgay in 1953.' },
      { title: 'Himalayan Range', content: 'The Himalayas stretch across five countries: India, Nepal, Bhutan, China, and Pakistan. The range contains over 100 peaks exceeding 7,200 meters in height. Mount Everest is known as Sagarmatha in Nepali and Chomolungma in Tibetan.' },
    ])],
    question: 'How tall is Mount Everest?',
    expectedKeywords: ['8,849', 'meters', 'everest'],
  },
  {
    name: 'SSR-05: Retrieve a causal relationship',
    docs: [makeDoc('Climate Science', [
      { title: 'Greenhouse Effect', content: 'The greenhouse effect occurs when gases in Earth\'s atmosphere trap heat from the sun. Carbon dioxide and methane are the primary greenhouse gases. This process causes global temperatures to rise, leading to climate change. Without any greenhouse effect, Earth\'s average temperature would be about minus 18 degrees Celsius.' },
      { title: 'Human Impact', content: 'Since the Industrial Revolution, human activities have increased atmospheric carbon dioxide levels by over 50 percent. Burning fossil fuels, deforestation, and industrial processes are the main contributors. The resulting enhanced greenhouse effect is causing measurable changes in global climate patterns.' },
    ])],
    question: 'What causes the greenhouse effect?',
    expectedKeywords: ['gases', 'atmosphere', 'trap', 'heat'],
  },
];

// ============================================================
// Test Category 2: Multi-Source Recall
// Can the system connect facts across different documents?
// ============================================================

export const multiSourceTests = [
  {
    name: 'MSR-01: Cross-reference two sources',
    docs: [
      makeDoc('Ada Lovelace', [
        { title: 'Biography', content: 'Ada Lovelace was a mathematician and writer in the 19th century. She worked closely with Charles Babbage on the Analytical Engine. She is widely considered the first computer programmer, having written what is recognized as the first algorithm intended for a machine.' },
        { title: 'Notes', content: 'Lovelace published a set of notes on the Analytical Engine in 1843. Her notes included an algorithm for computing Bernoulli numbers, which is considered the first computer program ever written.' },
      ]),
      makeDoc('Analytical Engine', [
        { title: 'Design', content: 'The Analytical Engine was designed by Charles Babbage in 1837. It was the first general-purpose computing machine ever conceived. The machine featured an arithmetic logic unit, control flow through conditional branching and loops, and integrated memory.' },
        { title: 'Legacy', content: 'Although the Analytical Engine was never completed during Babbage\'s lifetime, its design anticipated many features of modern computers. The collaboration between Babbage and Ada Lovelace produced foundational insights into programmable computation.' },
      ]),
    ],
    question: 'What is the connection between Ada Lovelace and the Analytical Engine?',
    expectedKeywords: ['lovelace', 'babbage', 'analytical engine'],
  },
  {
    name: 'MSR-02: Entity bridge across domains',
    docs: [
      makeDoc('Turing and Computing', [
        { title: 'Theory', content: 'Alan Turing proposed the concept of the universal Turing machine in 1936, which laid the theoretical foundation for modern computing. His paper "On Computable Numbers" addressed the Entscheidungsproblem and established fundamental limits of computation.' },
        { title: 'Impact', content: 'The Turing machine concept became the basis for the theory of computation. It provided a formal framework for understanding what can and cannot be computed by any mechanical process.' },
      ]),
      makeDoc('Turing and World War II', [
        { title: 'Bletchley Park', content: 'Alan Turing worked at Bletchley Park during World War II, where he helped break the Enigma code used by Nazi Germany. His work on the Bombe machine was crucial to Allied intelligence efforts and is estimated to have shortened the war by several years.' },
        { title: 'Codebreaking', content: 'Turing developed statistical techniques for breaking Enigma that were far more efficient than brute force approaches. His codebreaking work remained classified for decades after the war ended.' },
      ]),
    ],
    question: 'What did Alan Turing contribute to both computing and WWII?',
    expectedKeywords: ['turing', 'machine', 'enigma'],
  },
  {
    name: 'MSR-03: Synthesize across three sources',
    docs: [
      makeDoc('Microprocessor History', [
        { title: 'Intel 4004', content: 'The Intel 4004, released in 1971, was the first commercially available microprocessor. It was designed by Federico Faggin and contained 2,300 transistors. The chip could perform 92,000 operations per second and was originally designed for a calculator.' },
      ]),
      makeDoc('Operating Systems', [
        { title: 'Unix Origins', content: 'The Unix operating system was developed at Bell Labs in 1969 by Ken Thompson and Dennis Ritchie. Unix introduced many concepts still used today, including hierarchical file systems, pipes, and the C programming language which was created to rewrite Unix.' },
      ]),
      makeDoc('Internet History', [
        { title: 'ARPANET', content: 'ARPANET, the precursor to the modern internet, was established in 1969 connecting four university computers. The first message was sent from UCLA to Stanford Research Institute. ARPANET pioneered packet switching technology that would become the foundation of the internet.' },
      ]),
    ],
    question: 'What major computing developments happened around 1969-1971?',
    expectedKeywords: ['intel', 'unix', 'arpanet'],
  },
];

// ============================================================
// Test Category 3: Knowledge Update & Correction
// Can the system handle corrections and superseded information?
// ============================================================

export const knowledgeUpdateTests = [
  {
    name: 'KU-01: Supersede outdated information',
    docs: [makeDoc('Solar System', [
      { title: 'Planets', content: 'The solar system contains planets orbiting the Sun. For decades, Pluto was classified as the ninth planet of our solar system, discovered in 1930 by Clyde Tombaugh at Lowell Observatory. Pluto has a diameter of about 2,377 kilometers and orbits the Sun every 248 years.' },
      { title: 'Discovery', content: 'Clyde Tombaugh discovered Pluto on February 18, 1930. The discovery was the result of a systematic search for a planet beyond Neptune. Pluto was named after the Roman god of the underworld, following a suggestion by an eleven-year-old schoolgirl.' },
    ])],
    correction: {
      type: 'supersede' as const,
      content: 'Pluto was reclassified as a dwarf planet by the International Astronomical Union in 2006. It is no longer considered the ninth planet. The IAU established a new definition of planet that Pluto does not meet because it has not cleared its orbital neighborhood.',
      reason: 'IAU reclassification in 2006',
    },
    question: 'Is Pluto a planet?',
    expectedKeywords: ['dwarf planet', 'reclassified', '2006'],
  },
  {
    name: 'KU-02: Add new information',
    docs: [makeDoc('Language Models', [
      { title: 'GPT-3', content: 'GPT-3, released in June 2020 by OpenAI, was a major breakthrough in language models with 175 billion parameters. It demonstrated remarkable few-shot learning capabilities and could generate coherent text across many domains. GPT-3 was trained on a large corpus of internet text.' },
      { title: 'Impact', content: 'The release of GPT-3 sparked widespread interest in large language models. Many companies built products on top of the GPT-3 API. The model showed that scaling up parameters could lead to emergent capabilities not present in smaller models.' },
    ])],
    correction: {
      type: 'add' as const,
      content: 'GPT-4, released in March 2023, significantly improved upon GPT-3 with multimodal capabilities including image understanding. GPT-4 demonstrated human-level performance on various professional and academic benchmarks. It represents a substantial advancement in reasoning and instruction following.',
      reason: 'New model release',
    },
    question: 'What came after GPT-3?',
    expectedKeywords: ['gpt-4', '2023', 'multimodal'],
  },
];

// ============================================================
// Test Category 4: Temporal Reasoning
// Can the system understand and reason about time?
// ============================================================

export const temporalTests = [
  {
    name: 'TR-01: Chronological ordering',
    docs: [makeDoc('Computing Hardware Timeline', [
      { title: 'Early Computers', content: 'ENIAC, the Electronic Numerical Integrator and Computer, was completed in 1945. It was one of the first general-purpose electronic computers and weighed 30 tons. ENIAC could perform about 5,000 additions per second.' },
      { title: 'Transistor Era', content: 'The transistor was invented in 1947 at Bell Labs by John Bardeen, Walter Brattain, and William Shockley. The transistor replaced vacuum tubes and made electronics smaller, faster, and more reliable. This invention earned the Nobel Prize in Physics in 1956.' },
      { title: 'Integrated Circuits', content: 'The integrated circuit was developed in 1958 by Jack Kilby at Texas Instruments. Robert Noyce independently developed a similar concept at Fairchild Semiconductor. The integrated circuit combined multiple transistors on a single chip.' },
      { title: 'Microprocessor', content: 'The microprocessor appeared in 1971 when Intel released the 4004. This was the first time an entire CPU was placed on a single chip. The microprocessor revolution enabled personal computers and modern computing.' },
    ])],
    question: 'What came first, the transistor or the integrated circuit?',
    expectedKeywords: ['transistor', '1947', 'integrated circuit', '1958'],
  },
  {
    name: 'TR-02: Time-bounded query',
    docs: [makeDoc('Computing History', [
      { title: '19th Century', content: 'Charles Babbage designed the Difference Engine in 1822, a mechanical calculator for polynomial functions. Ada Lovelace wrote the first algorithm in 1843, intended for Babbage\'s Analytical Engine. These pioneering efforts laid the conceptual groundwork for modern computing.' },
      { title: '20th Century', content: 'Alan Turing published his seminal paper on computability in 1936, introducing the concept of a universal machine. ENIAC was completed in 1945 as one of the first electronic general-purpose computers. The transistor followed in 1947, revolutionizing electronics.' },
    ])],
    question: 'What happened in computing before 1900?',
    expectedKeywords: ['babbage', 'lovelace'],
  },
];

// ============================================================
// Test Runner
// ============================================================

export interface TestResult {
  name: string;
  category: string;
  passed: boolean;
  matchedKeywords: string[];
  expectedKeywords: string[];
  totalNodes: number;
  timeMs: number;
}

export function runAllTests(): {
  results: TestResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    accuracy: number;
    avgTimeMs: number;
    byCategory: Record<string, { passed: number; total: number }>;
  };
} {
  const results: TestResult[] = [];

  // Category 1: Single-Session Recall
  for (const test of singleSessionTests) {
    const start = performance.now();
    const graph = buildGraph(test.docs, 'test');
    const check = queryContains(graph, test.question, test.expectedKeywords);
    const elapsed = performance.now() - start;

    results.push({
      name: test.name,
      category: 'Single-Session Recall',
      passed: check.found,
      matchedKeywords: check.matchedKeywords,
      expectedKeywords: test.expectedKeywords,
      totalNodes: check.totalNodes,
      timeMs: Math.round(elapsed * 100) / 100,
    });
  }

  // Category 2: Multi-Source Recall
  for (const test of multiSourceTests) {
    const start = performance.now();
    const graph = buildGraph(test.docs, 'test');
    const check = queryContains(graph, test.question, test.expectedKeywords);
    const elapsed = performance.now() - start;

    results.push({
      name: test.name,
      category: 'Multi-Source Recall',
      passed: check.found,
      matchedKeywords: check.matchedKeywords,
      expectedKeywords: test.expectedKeywords,
      totalNodes: check.totalNodes,
      timeMs: Math.round(elapsed * 100) / 100,
    });
  }

  // Category 3: Knowledge Update
  for (const test of knowledgeUpdateTests) {
    const start = performance.now();
    const graph = buildGraph(test.docs, 'test');

    // Apply correction
    if (graph.tfidfIndex) {
      const firstNodeId = Array.from(graph.nodes.keys()).find(id => {
        const n = graph.nodes.get(id);
        return n && n.type !== 'document' && n.type !== 'section';
      });

      applyCorrection(graph, graph.tfidfIndex, {
        ...test.correction,
        nodeId: test.correction.type === 'supersede' ? firstNodeId : undefined,
        timestamp: Date.now(),
      });
    }

    const check = queryContains(graph, test.question, test.expectedKeywords);
    const elapsed = performance.now() - start;

    results.push({
      name: test.name,
      category: 'Knowledge Update',
      passed: check.found,
      matchedKeywords: check.matchedKeywords,
      expectedKeywords: test.expectedKeywords,
      totalNodes: check.totalNodes,
      timeMs: Math.round(elapsed * 100) / 100,
    });
  }

  // Category 4: Temporal Reasoning
  for (const test of temporalTests) {
    const start = performance.now();
    const graph = buildGraph(test.docs, 'test');
    const check = queryContains(graph, test.question, test.expectedKeywords);
    const elapsed = performance.now() - start;

    results.push({
      name: test.name,
      category: 'Temporal Reasoning',
      passed: check.found,
      matchedKeywords: check.matchedKeywords,
      expectedKeywords: test.expectedKeywords,
      totalNodes: check.totalNodes,
      timeMs: Math.round(elapsed * 100) / 100,
    });
  }

  // Summary
  const passed = results.filter(r => r.passed).length;
  const total = results.length;
  const avgTime = results.reduce((s, r) => s + r.timeMs, 0) / total;

  const byCategory: Record<string, { passed: number; total: number }> = {};
  for (const r of results) {
    if (!byCategory[r.category]) byCategory[r.category] = { passed: 0, total: 0 };
    byCategory[r.category].total++;
    if (r.passed) byCategory[r.category].passed++;
  }

  return {
    results,
    summary: {
      total,
      passed,
      failed: total - passed,
      accuracy: (passed / total) * 100,
      avgTimeMs: Math.round(avgTime * 100) / 100,
      byCategory,
    },
  };
}
