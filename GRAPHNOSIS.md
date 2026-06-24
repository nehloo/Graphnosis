# Graphnosis memory — instructions for AI assistants

v1.13.0

This project uses **Graphnosis** as its long-term memory: a local, encrypted
store the user owns, reached through MCP. Treat it as the source of truth for
anything that should outlive this conversation. The MCP tools are organized
into **10 groups** — pick by intent; the tool name shapes the audit footer.

## The two non-negotiable habits

1. **Recall first, answer second.** For any question that leans on prior
   context — past decisions, preferences, "what did we say about X?" — call
   `recall`/`remind` **before** answering, even if your own history looks
   empty. Graphnosis persists across sessions and AI clients.
2. **Remember proactively, in the user's words.** When the turn produces
   something durable — a decision (with one-line reason), a to-do, a draft, an
   open question, a new lasting fact — call `remember`. Don't wait to be
   asked. Save in the user's language; never translate "for safekeeping".
   Route topical notes with `target_engram`; call `stats` if you don't know
   the engrams yet.

## Query well — recall quality lives or dies here

Before any search tool, transform the user's utterance into a query:

- **Strip framing.** "Remind me where Nelu lived" → `unde a locuit Nelu` /
  `Nelu lived where`. Drop "remind me", "what did I say about", "do you know
  if" in any language.
- **Match the storage language.** The lexical index does not bridge
  languages. Heuristic: query in the language(s) you've seen in this
  session; if unknown, query in the user's current input language **plus**
  any other language they've used with you, plus English as fallback.
  Zero results → retry in 1–2 other plausible languages before declaring
  nothing found.
- **Add 1–2 same-language synonyms** ("locuit" won't match "trăit"; "live"
  won't match "reside"). TF-IDF has no semantic awareness.
- **Keep it dense.** 3–8 content words. No "the/a/is", no full sentences,
  no punctuation.
- **Anchor on proper nouns.** Verbatim spelling and capitalisation. Names,
  places, projects, URLs, dates are the strongest signal. Never
  transliterate (don't turn "Nelu" into "ネル").

Example (Arabic user, French-stored memory):
`مشروع تسويق projet marketing proposition` — translate key content words,
keep proper nouns intact, add same-language synonyms.

## Keep the memory clean

- Save **settled facts**, not speculation. Note uncertainty plainly if
  unsure; don't record guesses as fact.
- **No chat log, no jokes, no hypotheticals.** Memory is not a scratchpad.
- **To fix / update / add detail, use `edit` — never a second `remember`.**
  A second `remember` creates a conflicting duplicate.
- Ask before saving anything the user clearly wouldn't want kept.

## Sensitivity & consent (one-paragraph version)

Every engram is `public`, `personal`, or `sensitive`. Route private content
(credentials, health, finances) to a personal or sensitive engram — never to
public. `public` and `personal` recalls are silent. `sensitive` recalls
trigger an **in-app one-click consent modal** (Allow / Deny / Allow-1h /
Allow-today) — usually you'll just receive the results once the user clicks
Allow. Federated recall auto-excludes sensitive engrams you lack consent for;
the gate only fires when you explicitly name a sensitive engram via
`only_engrams` / `target_engram`. Recalls may be partial — don't assume you
can see everything stored.

**Headless fallback (SSH / Docker / CI):** if a recall returns
`⚠️ GRAPHNOSIS CONSENT REQUIRED`, present the notice **verbatim**, tell the
user to open **Settings → AI → Consent Phrases**, wait for them to type it,
call `confirm_data_access({phrase, tier})` with exactly what they typed, then
retry. If they type SKIP, do not retry and do not invent the phrase.

## The tools — pick by intent

### Core memory (8)
- `recall` — semantic search; ready-to-read context block. **Escalation
  policy:** 0–3 nodes (or nodes that don't answer the question) → call
  `dig_deeper` with the same query **before** saying "nothing found". If
  your client uses deferred schema loading, pre-load `dig_deeper` before
  the first `recall`.
- `remind` — alias for `recall`, same input + results + escalation policy.
- `dig_deeper` — the look-harder escalation. Orchestrates content recall +
  source-filename expansion + cross-engram entity hop, with full provenance.
  Watch the response for a `💡 The query entities also match source-file
  names…` hint with sourceIds — **stop and call `recall_source` on those
  IDs** before composing your answer; a whole document is relevant.
- `remember` — save a new memory. Pass `target_engram` for topical routing.
- `forget` — soft-delete specific **nodes**. **Always call
  `recall_structured` first**, then pass `items: [{nodeId, preview}]` where
  `preview` is the first ~120 chars of `node.text` — the user sees the
  consent prompt and needs human-readable text, not opaque IDs. To delete a
  whole source: direct the user to the Sources page in the app; AI clients
  cannot.
- `apply` — commits an already-approved diff. App-driven; AI rarely calls.
- `stats` — engram inventory + node counts. Useful before picking
  `target_engram` or debugging "where did my notes go?".
- `vitality` — 0–100 cortex health score.

### Engram discovery (5)
- `list_engrams` — names + tiers + source counts.
- `suggest_engram` — best engram to save a note into (lexical match).
- `browse_engram` — sources inside one engram, newest first.
- `recent` — most recently ingested sources, all engrams.
- `get_engram_schema` — metadata (tier, template, display name).

### Structured recall (4)
- `recall_structured` — `recall` as JSON node array.
- `recall_with_citations` — inline per-fact source citations.
- `compare_engrams` — same query, two engrams, side-by-side.
- `cross_search` — federated recall over a hand-picked subset of engrams.

### Source operations (3)
- `find_source` — keyword search across source IDs / refs / kinds.
- `recall_source` — full content of one source, in ingestion order. Use when
  `recall` fragments a structured document, or when a 💡 hint named it.
- `transfer_source` — move a source between engrams.

### Engram operations (2)
- `ingest_batch` — up to 20 notes per call, each with its own `target_engram`.
- `engram_summary` — counts + node previews snapshot.

(Merging engrams is a user-only action in the app — no MCP tool.)

### Skills / SOPs (12)
The procedural-memory layer — Standard Operating Procedures stored in the
**Skills engram** that ships with every cortex. A skill is a graph of body
steps with 5 evidence-tagged edge types (`skill:seq`, `skill:loop`,
`skill:branch`, `skill:ctx`, `skill:calls`) and 8 goal categories per skill
(Success, Out of scope, On completion, Trigger, Prerequisites, On failure,
Requires, Produces).

- `walk_skill` — step-by-step narrative SOP text with ⟲ (loop) / ⤳ (branch) /
  ⊕ (sub-skill) annotations. Use for **explaining** to the user.
- `walk_skill_structured` — same walk as a `SkillExecutionPlan` JSON:
  `requires` (+ `requiresTypes` inline type hints), `produces`, ordered
  `steps[].calls` with args + `captureAs`, `steps[].parallel` (concurrent
  sub-skills), `steps[].maxIterations` (loop-convergence cap), cross-engram
  calls flagged with `targetGraphId`, and `failureHandlers`. **Prefer this for
  any procedural execution task** — walk steps in order, invoke sub-skills with
  the named args, run `parallel` members concurrently, respect `maxIterations`
  on loops, capture returns, route to `failureHandlers[0]` on exception.
- `save_skill_run` — persist captured vars + progress of a multi-skill run so
  it can resume in a later session; returns a `runId` (omit to start a new run,
  pass it back to update). Call as you walk.
- `resume_skill_run` — reload a saved run by `runId`: captured vars, last
  completed step, and `nextStepIndex` to continue at.
- `get_skill` — fetch one trained skill's rendered output.
- `list_skills` — every skill with metadata.
- `train_skill` — train or retrain a skill (in-place; one source per skill;
  writes a snapshot to history). Free path = deterministic memory-augmented
  body with `_(from source)_` attribution; Pro path = LLM-rewritten body
  with same attribution. The user's license picks the path, not you.
- `export_skill` — write a signed `.gsk` pack (AES-256-GCM + Ed25519
  signature). Magic bytes `GSK\x01`. Older `.gts` extension still imports.
- `delete_skill` — soft delete.
- `skill_history` — snapshot chain (mode, timestamp, diff summary).
- `rollback_skill` — restore a prior snapshot (itself recorded as a new
  snapshot; lineage preserved).
- `skill_vitality` — per-skill 0–100 health (staleness, anchor coverage,
  goal completeness, structure resolution).

Cross-skill orchestration syntax inside a step:
`@skill: target-name(arg=value, arg=$priorVar) -> $captureName`. Bare form
`@skill: target-name` also works (no args, no capture).

### Brain maintenance (5) — read-only windows into the background brain
- `duplicate_pairs` — near-IDENTICAL node pairs the background scan queued for
  review. Resolve via `edit` (merge) or `forget`.
- `contradiction_pairs` — near-OPPOSITE pairs: memories sharing entities but
  asserting conflicting content, flagged by the periodic reflection scan.
  Resolve by superseding the outdated side via `edit` — NEVER by adding a
  third note. If both are true (context-dependent), tell the user to dismiss
  the pair in the app's Needs-you review.
- `healing_journal` — audit log of autonomous merges the brain applied.
- `gnn_status` — Neural Network status (enabled, edge count, last run).
- `confirm_data_access` — headless consent fallback (see the consent section).

### Approximate (2) — similarity scans, no LLM
- `audit_memory` — near-duplicate detection across engrams.
- `check_duplicate` — pre-`remember` similarity check.

### Conditional (1) — deterministic by default, LLM-aware when enabled
- `edit` — propose a structured diff for CORRECTION ("actually it was
  September"), UPDATE ("plans changed — update Q3 milestones to…"), or
  APPEND ("add these items to my project plan"). **Never use `remember` to
  modify** — creates a conflicting duplicate. The `mode` field reports
  which path ran (`deterministic` / `gnn-expanded` / `llm-assisted`).

### Non-deterministic (6) — require local LLM (Ollama) on the user's machine
- `develop` — strategic plan grounded in the user's memory.
- `predict` — risks + opportunities before the user acts.
- `insights` — background-loop patterns / gaps / opportunities.
- `gnn_neighbors` — Neural-Network-predicted related nodes.
- `llm_query` — synthesised answer from recall, computed locally. **Prefer
  over raw `recall` when the question requires assembling facts from
  multiple nodes/engrams into one coherent answer** (summarise, compare,
  pattern across decisions). For point-lookups, plain `recall` is faster.
- `llm_distill` — extract discrete facts from arbitrary text, ready for
  `ingest_batch`.

## The local LLM — what it does, what it does not

Capabilities are toggled independently in **Graphnosis → Non-Deterministic
Aid → Local LLM**:

| Capability | Effect | Writes to graph? |
|---|---|---|
| Recall enrichment | Rewrites your query at recall time | No |
| Correction parsing | Upgrades `edit` to author multi-edit diffs | Only after user approval |
| Distillation | Powers `llm_distill` | No |
| Insights / predictions | Powers `insights`/`develop`/`predict`/`llm_query` | Writes to `.gll` overlay only |
| Edge prediction | Background loop proposing connections | Writes to `.gll`, never to `.gai` |
| Skill training (Pro) | LLM-rewritten skill body, attribution preserved | Writes to `.gai` only after the user trains |

What follows:

- **Don't assume the LLM is on.** `insights`/`develop`/`predict`/
  `llm_query`/`llm_distill` may return "Local LLM unavailable"; surface
  plainly with the toggle path. Don't pretend the feature ran.
- **Recall enrichment, when on, is invisible.** Your query is rewritten
  server-side; a `_enriched: "..." → "..."_` footer shows what ran.
  Informational — don't try to undo it.

## Layered memory: `.gai` / `.gnn` / `.gll`

Three physical layers with different determinism contracts:

| Layer | File | Contains | Mutable by |
|---|---|---|---|
| Canonical | `.gai` | Every memory the user attested (or you saved on their behalf) | Only the user, via approved `edit` diffs |
| Neural network overlay | `.gnn` | Predicted edges from a local GNN | The GNN's training pass; user discards via UI |
| Local LLM overlay | `.gll` | Predicted edges + synthesised assertions from the local LLM | The LLM's inference loops; user discards via UI |

The LLM and the GNN **cannot** mutate `.gai`. The only path to attested
change is an `edit` diff the user approves. This is structural — different
files, different write privileges.

### How recall surfaces the layers

Each recall response is structured as:

1. **`=== KNOWLEDGE SUBGRAPH ===`** per engram — drawn purely from `.gai`,
   the authoritative answer. Node format
   `[shortId|nodeType|score|src:label|date:YYYY-MM-DD] content`. Edges
   `n1 -[edgeType:weight]-> n2` (directed) or `n1 ~[edgeType:weight]~ n2`
   (undirected). `--- SESSION SUMMARIES ---` carries compressed prior-session
   context (`claims:` line = pipe-separated atomic facts).
2. **`--- CROSS-GRAPH CONNECTIONS ---`** (multi-engram queries only) — entity
   overlap with short previews from each engram. Attested; derived from `.gai`.
3. **Audit footer + footnotes** — `_anchored on entities: …_`,
   `_GNN expanded recall by N node(s) at ≥65% confidence_`,
   `_enriched: "…" → "…"_`.
4. **`--- INFERRED LAYER (overlays — NOT attested memory) ---`** (only when
   overlay engines are on and intersect the result) — rows tagged
   `[gll·assertion N%]`, `[gll·edge N%]`, `[gnn·edge N%]`.

What you do with the inferred layer:

- **Cite as a prediction, not a fact.** "Based on a local-LLM inference
  with ~78% confidence" — never "you said X" when X is from `[gll·…]`.
- **Attested wins on conflict.** If `.gai` says Bucharest and `[gll·…]`
  infers Cluj, mention the discrepancy and offer `edit` if appropriate.
- **Never `remember` an inferred row.** That promotes a prediction to
  attested memory — the failure mode overlays exist to prevent. If the
  user confirms the inference, save the user's confirmation as a new
  attested memory.
- **`forget` doesn't touch overlays.** It operates on `.gai` node IDs
  only. Overlay content is wiped via the Foresight controls.

### `dig_deeper`-specific shape

`dig_deeper` extends the standard subgraph with two extra labelled sections
and italic provenance bullets:

```
[Stage 1: standard recall subgraph]

## DIG_DEEPER — Source-filename expansion
### Engram Name (additional chunks from matched source filenames)

## DIG_DEEPER — Cross-engram entity hop
_Pulled via shared entities: EntityA, EntityB_
### Engram Name
```

Then provenance bullets: `_• Content match (recall): N nodes…_`,
`_• Source-filename expansion: N nodes from M source(s)…_`,
`_• Cross-engram entity hop: N nodes via M shared entities…_`.

If indirect stages dominated (>60% of nodes), a ⚠️ heads-up follows — when
you see it, surface that the answer is mostly indirect expansion, not a
direct content match, and invite the user to rephrase.

## Skills — quick agent guidance

When the user asks you to **run** a procedure:

1. `walk_skill_structured { sourceId }`.
2. Read `requires[]` → confirm each input with the user.
3. Read `constraints.prerequisites` → ask if satisfied; abort if not.
4. Walk `steps[]` in order. For each step with `calls`:
   - Resolve `args[]` from prior `$captures` + literals.
   - Recursively `walk_skill_structured` on `targetSourceId` (or just
     execute if the calling step is the leaf).
   - Store result under `captureAs` for downstream steps.
5. On exception, route to `failureHandlers[0]` instead of stopping.
6. Final answer: report the captured variables explicitly.

When the user asks you to **explain** a procedure: use `walk_skill` for
narrative text instead. Two paired tools, two distinct purposes.

`unresolvedCall` on a step means the named sub-skill wasn't found in the
same engram — surface to the user; **do not** auto-create. Cross-engram
calls are not supported in v1.

## When Graphnosis is not connected

Tools work only while the Graphnosis app is open and the cortex is unlocked.
If unavailable, carry on — but tell the user, and ask them to open the app,
unlock the cortex, and re-prompt so the last step gets recalled or saved.
