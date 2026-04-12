// LongMemEval-style benchmark suite for graphAI
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
    docs: [makeDoc('Events', [{ title: 'History', content: 'The Apollo 11 mission landed on the Moon on July 20, 1969. Neil Armstrong was the first human to walk on the lunar surface.' }])],
    question: 'When did Apollo 11 land on the Moon?',
    expectedKeywords: ['1969', 'apollo', 'moon'],
  },
  {
    name: 'SSR-02: Retrieve a person-fact association',
    docs: [makeDoc('Scientists', [{ title: 'Physics', content: 'Albert Einstein developed the theory of general relativity in 1915. He was awarded the Nobel Prize in Physics in 1921 for his explanation of the photoelectric effect.' }])],
    question: 'What did Einstein win the Nobel Prize for?',
    expectedKeywords: ['photoelectric', 'nobel', 'einstein'],
  },
  {
    name: 'SSR-03: Retrieve a definition',
    docs: [makeDoc('Computing', [{ title: 'Definitions', content: 'A Turing machine is a mathematical model of computation that defines an abstract machine which manipulates symbols on a strip of tape according to a table of rules.' }])],
    question: 'What is a Turing machine?',
    expectedKeywords: ['mathematical', 'model', 'computation', 'tape'],
  },
  {
    name: 'SSR-04: Retrieve a numerical fact',
    docs: [makeDoc('Geography', [{ title: 'Mountains', content: 'Mount Everest stands at 8,849 meters above sea level, making it the tallest mountain on Earth. It is located in the Himalayan mountain range on the border between Nepal and Tibet.' }])],
    question: 'How tall is Mount Everest?',
    expectedKeywords: ['8,849', 'meters', 'everest'],
  },
  {
    name: 'SSR-05: Retrieve a causal relationship',
    docs: [makeDoc('Science', [{ title: 'Climate', content: 'The greenhouse effect occurs when gases in Earth\'s atmosphere trap heat from the sun. Carbon dioxide and methane are the primary greenhouse gases. This process causes global temperatures to rise, leading to climate change.' }])],
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
      makeDoc('Doc A', [{ title: 'Person', content: 'Ada Lovelace worked with Charles Babbage on the Analytical Engine. She is considered the first computer programmer.' }]),
      makeDoc('Doc B', [{ title: 'Machine', content: 'The Analytical Engine was designed by Charles Babbage in 1837. It was the first general-purpose computing machine ever conceived.' }]),
    ],
    question: 'What is the connection between Ada Lovelace and the Analytical Engine?',
    expectedKeywords: ['lovelace', 'babbage', 'analytical engine'],
  },
  {
    name: 'MSR-02: Entity bridge across domains',
    docs: [
      makeDoc('Physics', [{ title: 'Theory', content: 'Alan Turing proposed the concept of the universal Turing machine in 1936, which laid the theoretical foundation for modern computing.' }]),
      makeDoc('History', [{ title: 'WWII', content: 'Alan Turing worked at Bletchley Park during World War II, where he helped break the Enigma code used by Nazi Germany.' }]),
    ],
    question: 'What did Alan Turing contribute to both computing and WWII?',
    expectedKeywords: ['turing', 'machine', 'enigma'],
  },
  {
    name: 'MSR-03: Synthesize across three sources',
    docs: [
      makeDoc('Hardware', [{ title: 'CPU', content: 'The Intel 4004, released in 1971, was the first commercially available microprocessor.' }]),
      makeDoc('Software', [{ title: 'Unix', content: 'The Unix operating system was developed at Bell Labs in 1969 by Ken Thompson and Dennis Ritchie.' }]),
      makeDoc('Networking', [{ title: 'ARPANET', content: 'ARPANET, the precursor to the modern internet, was established in 1969 connecting four university computers.' }]),
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
    docs: [makeDoc('Planets', [{ title: 'Solar System', content: 'Pluto is the ninth planet of our solar system, discovered in 1930 by Clyde Tombaugh.' }])],
    correction: {
      type: 'supersede' as const,
      content: 'Pluto was reclassified as a dwarf planet by the International Astronomical Union in 2006. It is no longer considered the ninth planet.',
      reason: 'IAU reclassification in 2006',
    },
    question: 'Is Pluto a planet?',
    expectedKeywords: ['dwarf planet', 'reclassified', '2006'],
  },
  {
    name: 'KU-02: Add new information',
    docs: [makeDoc('Tech', [{ title: 'AI', content: 'GPT-3, released in 2020, was a major breakthrough in language models with 175 billion parameters.' }])],
    correction: {
      type: 'add' as const,
      content: 'GPT-4, released in March 2023, significantly improved upon GPT-3 with multimodal capabilities including image understanding.',
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
    docs: [makeDoc('Timeline', [
      { title: 'Events', content: 'ENIAC was completed in 1945. The transistor was invented in 1947 at Bell Labs. The integrated circuit was developed in 1958 by Jack Kilby. The microprocessor appeared in 1971.' },
    ])],
    question: 'What came first, the transistor or the integrated circuit?',
    expectedKeywords: ['transistor', '1947', 'integrated circuit', '1958'],
  },
  {
    name: 'TR-02: Time-bounded query',
    docs: [makeDoc('History', [
      { title: 'Computing', content: 'Charles Babbage designed the Difference Engine in 1822. Ada Lovelace wrote the first algorithm in 1843. Alan Turing published his paper on computability in 1936. ENIAC was completed in 1945.' },
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
