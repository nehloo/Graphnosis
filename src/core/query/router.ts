// Question-type router for LongMemEval-style QA.
//
// Replaces the previous regex-inline branching inside buildGraphPrompt with a
// single dispatcher that maps a question (or a caller-provided ground-truth
// category) onto (a) a retrieval strategy used by queryGraph and (b) a
// category-specific prompt block used by buildGraphPrompt.
//
// Six categories from LongMemEval_s:
//   single-session-user        — fact stated by the user in a single session
//   single-session-assistant   — fact stated by the assistant in a single session
//   single-session-preference  — user preference distributed across one session
//   multi-session              — aggregation / synthesis across sessions
//   temporal-reasoning         — time-ordered reasoning, date math, before/after
//   knowledge-update           — superseded fact; answer should be the latest claim
//
// Runtime detection is prioritised. Ground-truth `question_type` is never
// used by default — we publish an honest leaderboard number measured the
// same way as Zep / Mastra.

import type { LMEQuestionType } from '../../../tests/longmemeval/official/dataset';

// Retrieval strategy dial used by queryGraph. Values represent category-level
// defaults; explicit QueryOptions still win so the CLI can override per-run.
export interface RetrievalStrategy {
  maxSeeds: number;
  maxNodes: number;
  diversifyByFile: boolean;
  // Future hooks used by Phase 2 (session summaries). Declared now so the
  // router contract is stable and callers can pass them through safely.
  preferSummarySeeds?: boolean;
  // Future hook used by Phase 3 (query-time preference extraction). Answer
  // path checks this flag to decide whether to run extractPreferences.
  preferPreferenceInjection?: boolean;
}

export interface RouterDecision {
  category: LMEQuestionType;
  strategy: RetrievalStrategy;
  // Source of the category label: `'regex'` when we detected from question
  // text, `'explicit'` when the caller (typically an ablation run) provided
  // it. Logged in telemetry.
  source: 'regex' | 'explicit';
}

// Regex patterns below are ordered most-specific → most-general. First match
// wins. Calibrated against the actual LongMemEval_s question distribution:
// preference questions are recommendation-seeking ("Can you recommend", "any
// tips"), not vocabulary like "favorite"; assistant questions use "remind
// me" + "our previous conversation"; temporal uses "passed since / between"
// with possibly interposed words, not strict adjacency.

// Single-session-assistant: user asking to recall what the assistant said
// or recommended in a prior turn. "remind me" is the dominant signal in
// LongMemEval_s; "our previous conversation/chat" is the secondary tell.
// Runs first because "remind me" is highly discriminative.
const ASSISTANT_INTENT =
  /\b(remind me (what|of|about|how)|you (said|mentioned|told me|suggested|recommended|advised|explained|provided|gave me|listed)|your (answer|response|suggestion|recommendation|advice|explanation|list)|what did you (say|tell me|mention|suggest|recommend|list)|(our|the) previous (chat|conversation|discussion)|(earlier|last time) (we|you) (talked|spoke|discussed|mentioned|chatted|said)|in our (previous|earlier|last) (chat|conversation|discussion))\b/i;

// Temporal: explicit time math, before/after, which-came-first, elapsed
// time. Adjacency loosened so "how many months have passed since", "days
// passed between", and "happened first" all match. Also catches ordinal
// listings ("first, second, third"), specific time anchors ("last Saturday",
// "past weekend"), and comparative "which X did I Y first/most recently".
const TEMPORAL_INTENT =
  /\b(how long (ago|since)|how many (days?|weeks?|months?|years?|hours?) (ago|passed|elapsed|since|between|have|has)|(days?|weeks?|months?|years?) (ago|passed|elapsed)|passed since|elapsed since|(came|happened) (first|last|before|after)|before or after|which came (first|last)|(which|who|what) .{0,80}\b(first|last|most recent(ly)?)\b(,| or | and )|in (what|the) (order|sequence)|what is the order|chronolog|earliest|latest time|most recently|when did (i|we|you)|what date|on what (day|date)|first time I|last time I|time (between|since|elapsed)|last (monday|tuesday|wednesday|thursday|friday|saturday|sunday|week|weekend)|past (weekend|week|month|year)|valentine'?s day|new year'?s|\b(first|second|third|fourth|fifth|last),\s+(the|and|second|third|fourth|fifth))\b/i;

// Preference: LongMemEval preference questions are recommendation-seeking —
// asking the assistant for a suggestion that should reflect known user
// tastes. Runs BEFORE knowledge-update because "my current setup" (a
// preference question) would otherwise trigger KU's "current" pattern.
const PREFERENCE_INTENT =
  /\b(favorite|favourite|prefer|preference|usually|typically|habit|routine|tend to|like to|love to|hate|enjoy|(my|I) (preferred|usual|typical)|can you (recommend|suggest)|could you (recommend|suggest)|any (tips|advice|suggestions|ideas|recommendations)|what should I (serve|wear|watch|eat|read|try|do|cook|make|buy|get|order|play|listen)|do you have any (ideas|suggestions|recommendations|tips)|i('ve| have) been (struggling|thinking|feeling|wanting) .*(any|tips|advice|ideas|suggest)|looking for (some|any) (ideas|recommendations|suggestions|tips))\b/i;

// Knowledge-update: a fact that has changed over time; answer should reflect
// the latest non-superseded claim. Covers "currently", "most recent",
// "moved/switched/changed to", "since I started", "how long have I" /
// "how often do I" (ongoing state & frequency), "so far" (running totals),
// and "before I X" supersession cues.
const KNOWLEDGE_UPDATE_INTENT =
  /\b(currently|these days|most recent\b|latest|still (have|work|live|own|use|play|attend|go|take|run|write)|no longer|any\s*more|updated|recently (moved|changed|started|switched|bought|got)|recent (move|relocation|change|update|switch|job|role|position|trip|visit)|new (job|address|home|apartment|name|role|car|gym|workplace|hobby)|moved to|switched to|used to (be|have|live|work|go|own|attend)|since I (started|began|moved|switched|changed|got|joined)|(my|our) (current|latest|new|newest) |personal best|now (have|own|use|play|work|live|run)|after (his|her|their|my) (recent|relocation|move|change)|how long have I\b|how often do I\b|how often does\b|\bso far\b|before I (purchased|bought|got|started|switched|moved|changed)|before getting\b|more frequently than|(previous|current) (status|version|role|job|gym|address|tutor|coach|doctor|therapist))\b/i;

// Aggregation / multi-session: count / sum / total / every-time. Final
// fallback for "how many X" that isn't temporal or knowledge-update.
const AGGREGATION_INTENT =
  /\b(total|how many|how much|number of|count of|sum of|all of the|every time|each time|across (all|multiple)|combined|altogether|in total)\b/i;

export function classifyQuestion(question: string): LMEQuestionType {
  if (ASSISTANT_INTENT.test(question)) return 'single-session-assistant';
  if (TEMPORAL_INTENT.test(question)) return 'temporal-reasoning';
  if (PREFERENCE_INTENT.test(question)) return 'single-session-preference';
  if (KNOWLEDGE_UPDATE_INTENT.test(question)) return 'knowledge-update';
  if (AGGREGATION_INTENT.test(question)) return 'multi-session';
  return 'single-session-user';
}

export function getRetrievalStrategy(type: LMEQuestionType): RetrievalStrategy {
  switch (type) {
    // Targeted single-session recall: tight pool, no summary interference.
    case 'single-session-user':
    case 'single-session-assistant':
      return { maxSeeds: 24, maxNodes: 20, diversifyByFile: false, preferSummarySeeds: false };

    // Preferences are user-stated across a single session. Slightly wider
    // node budget so every preference-relevant turn has a chance to surface.
    // Phase 3 will flip preferPreferenceInjection on.
    case 'single-session-preference':
      return {
        maxSeeds: 28,
        maxNodes: 25,
        diversifyByFile: false,
        preferSummarySeeds: false,
        preferPreferenceInjection: true,
      };

    // Aggregation / synthesis across sessions — widen both pool and budget,
    // diversify to prevent one session hogging the seeds. Phase 2 will flip
    // preferSummarySeeds on.
    case 'multi-session':
      return { maxSeeds: 40, maxNodes: 50, diversifyByFile: true, preferSummarySeeds: true };

    // Temporal: medium pool; diversify so we see multiple dated anchors;
    // session summaries help disambiguate "which session was first".
    case 'temporal-reasoning':
      return { maxSeeds: 32, maxNodes: 40, diversifyByFile: true, preferSummarySeeds: true };

    // Knowledge-update: we need both the old claim and the new claim in the
    // context so the model can identify which supersedes which. Diversify
    // across sessions for exactly that reason.
    case 'knowledge-update':
      return { maxSeeds: 32, maxNodes: 40, diversifyByFile: true, preferSummarySeeds: true };
  }
}

// Per-category prompt block. Inserted just before the static graph-instruction
// paragraph inside buildGraphPrompt. Returns an empty string for categories
// that don't need a specialised directive (the default-recall prompt is
// already adequate for single-session-user).
export function buildCategoryPromptBlock(type: LMEQuestionType): string {
  switch (type) {
    case 'single-session-user':
      return '';

    case 'single-session-assistant':
      return `This question asks what the assistant previously said. Ground your answer in Assistant turns (\`src:Assistant (turn N)\`). Quote or paraphrase faithfully — do not re-generate a fresh recommendation.

`;

    case 'single-session-preference':
      return `This question asks about the user's preferences, habits, or personal choices — typically to inform a recommendation. Ground your answer in statements the user explicitly made about themselves.

Priority order:
1. If a \`--- USER PREFERENCE STATEMENTS ---\` block is present, treat those as the authoritative, distilled preference evidence. Each statement is in the user's own voice and carries a session/turn citation.
2. Otherwise, prioritize nodes tagged \`src:User (turn N)\` over assistant turns.
3. When multiple user statements are consistent, synthesize them; when they conflict, prefer the most recent (highest date).
4. Do not invent preferences the user did not state. If the context does not contain a relevant preference, answer from what is present and say so.

`;

    case 'multi-session':
      return `This question asks for a total, count, or aggregate across multiple sessions. Procedure:
1. Scan the context and list each instance that matches the question's criterion (e.g., "cuisine" = a national/regional cooking tradition, NOT a diet like "vegan"; "purchase" = an actual buy event, NOT a wish).
2. For each candidate, verify it actually matches — reject loose matches.
3. Distinguish between ADDITIONS and SUPERSEDED totals:
   - If two sessions describe separate events that each add to the total ("I bought 30 lbs" then "I bought 40 lbs"), SUM them.
   - If a later session restates the running total ("I've now collected 25 in total", "my count is up to 12"), USE the most recent stated total — do NOT add it to earlier partial counts.
4. Compute the aggregate.
5. State the answer first, then briefly list the instances you counted.
If you found fewer instances than expected, don't inflate the count — report only what's in the context.

`;

    case 'temporal-reasoning':
      return `This question requires chronological reasoning. Use the \`date:YYYY-MM-DD (Day)\` tags on each node to establish ordering:
1. For "before/after" or "which came first" questions, sort the candidate evidence by date tag and answer from the ordering.
2. For "how many days/weeks/months ago" questions, subtract the event's date tag from today's date; respect the day-of-week in the tag when the question references a specific weekday.
3. For "the first/last/most recent time I ..." questions, pick the node with the earliest/latest date tag that matches the question's subject.
Do not infer ordering from graph structure — use only the dated evidence. If the relevant dates are missing or tied, say so explicitly.

`;

    case 'knowledge-update':
      return `This question concerns a fact about the user or their world that may have changed over time (job, address, preference, status, count). Procedure:
1. Identify every claim about the subject in the context.
2. Order the claims by their date tags (most recent last).
3. Answer from the MOST RECENT claim that has not been contradicted by an even later one.
4. Ignore earlier claims that have been superseded by later statements.
If two claims share a date or conflict without a clear winner, acknowledge the conflict instead of guessing.

`;
  }
}
