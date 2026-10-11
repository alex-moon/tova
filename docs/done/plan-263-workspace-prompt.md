# Plan — #263 Workspace-era system prompt

Epic: [#251](https://github.com/alex-moon/tova/issues/251). Slice ticket:
[alex-moon/tova#263](https://github.com/alex-moon/tova/issues/263). Companion to
[#259](https://github.com/alex-moon/tova/issues/259) (the stance layer, landed in
`docs/done/plan-259-system-prompt.md`).

## Motivation

#251 makes Tova a workspace-centric personal agent: chats and tasks are activities
over a durable workspace (files, transcripts, digests) with provenance, and memory is
RAG over that map. The existing `SYSTEM_PROMPT` (`apps/server/src/services/promptAssembly.ts`)
is still a single-conversation persona — "the thing people reach for instead of Googling
or texting a friend at 11pm" — with no account of the workspace and no dispositions for
*knowing things* as a conversation rather than a database being queried at the person.

#259 added the *stance* layer (how to treat the person). This ticket is the "how to know
things and how to work" layer, authored as one constitution with it (the two are a single
`SYSTEM_PROMPT`, not two patches):

1. **Identity + memory honesty.** Tova is a personal agent over the user's workspace.
   Never pretend to remember something you weren't given; never hide where something came
   from. Attribution makes memory feel like being known, not watched.
2. **Grounding disposition.** Retrieved context is an *offer*, not a fact. Use a fragment
   only where it genuinely connects; the live conversation outranks stale material.
3. **Absence of information is information.** No visible connection is information, not
   failure. Invite intent only when the view is thin *and knowing more would change what
   you do* — once, in your own words, at the natural moment.
4. **Epistemic contract (weights/world split).** Disposition, reasoning, the given clock,
   the user's own material: from the weights, no citation. Time-sensitive, specific, or
   subject-matter claims about the world: grounded in tools/retrieval, cited. (Arithmetic is
   *not* weights-side — see the correction below; it gets a tool in a follow-up slice.)
5. **Conversation shape.** Memory lives in the workspace, not the transcript, so help
   conversations *finish*; a fresh conversation loses nothing.

## Decisions

- **Merge, not rewrite.** The #259 stance and emotional-weight paragraphs stay verbatim
  (their phrases are test-pinned); the new layers are woven around them. No change to
  routing, the envelope machinery, the gate, or #253's retrieval internals — prompt text
  only, as the ticket's Constraints require.
- **Size budget: ~2× the prior prompt, still bounded.** The prompt grows from ~412 to
  ~800 words — a real constitution, but every line earns its place and nothing depends on
  the ~1M-token roster windows (both current roster models are ~1M; the prompt must stay
  correct if a future model is smaller). This is the ticket's "prompt size budget" owner
  decision: **settled at roughly double the pre-#263 prompt, not a free expansion.**
- **State vocabulary lives in the envelope intros, not a separate state tag.** Settles
  the ticket's "where the state vocabulary lives" owner decision. v1 injects a block only
  on positive lexical overlap, so the model effectively sees one state — *nodes present,
  possibly weakly connected* — which the existing `<user:workspace>` intro already carries
  ("it may be stale or superseded, so do not assert it as fact …"). "Gate fired, nothing
  worth injecting" produces no block, so there is nothing for the model to see. No new
  envelope variant and no state tag is added in this slice (that would be a #253-internals
  change, out of scope); if gate evals later need to distinguish weak-vs-strong connection,
  that is a #253 follow-up.
- **No literal example strings in the new layers.** Per the ticket: the prompt carries
  intent; the model phrases its own invitations and check-ins in the moment. The one
  pre-existing quoted illustration ("I'm just an AI, but—", #259) stays because it is
  test-pinned and is a *disposition to avoid*, not a phrasing to copy.
- **No ZDR-specific clause.** The honesty clauses already cover it: a ZDR turn injects no
  workspace block, so "never pretend to remember something you weren't given" is the whole
  contract. A separate ZDR sentence would be a mechanical condition, which the ticket
  discourages. Retrieval staying read-only on ZDR is a #253 property, unchanged here.
- **Conversation-shape nudge is prompt-side only.** Settles the ticket's third owner
  decision: **no follow-up client/session ticket is opened from this slice.** The nudge is
  a disposition ("help it finish"); client/session UX affordances (an explicit "start
  fresh" surface) are a separate product question, deliberately out of scope here.
- **New deterministic eval coverage for the "don't over-search" side.** Existing golden
  cases already pin the *world* side (a current-events question requires `web_search` +
  inline sources: `pm-announcements-web`, `benchmaxxed-evals-web`) and absence
  (`no-sources-unanswerable` requires an explicit no-sources signal). A new case
  (`arithmetic-no-search`) pins the negative: a calculation must not trigger a web search
  or a file read.
- **Arithmetic is a tool case, not a weights case (owner correction, 2026-10-11).** The
  ticket's layer-4 list named arithmetic as weights-side; that premise is wrong — LLMs are
  unreliable at multi-digit arithmetic. This slice **drops arithmetic from the "trust
  yourself" list**; a dedicated calculator tool (mathjs number-only, locked down) is a
  follow-up slice that will move arithmetic to the tools side. The `arithmetic-no-search`
  case stays (its negative assertion still holds) and will be repointed at the calculator
  when that lands.

## Done

- [x] `promptAssembly.ts`: extend `SYSTEM_PROMPT` with the five #263 layers, composed
      with the #259 stance/emotional paragraphs (verbatim) and the brevity rule (last).
- [x] `promptAssembly.test.ts`: pin the new dispositions and that conversation shape sits
      before the brevity rule; keep the existing stance/no-trigger pins green.
- [x] `evals/cases.ts`: add `arithmetic-no-search` (negative: no reflex tool use).
- [x] `evals/cases.test.ts`: pin the new case.
- [x] `npm run ci` green (96 suites, 1194 tests; client lint/format/test/build).
- [x] PR [#282](https://github.com/alex-moon/tova/pull/282) opened against
      `epic/251-workspace`.

## Verification

- `npm run ci` (server lint/format/typecheck/test, client lint/format/test/build).
- Golden eval suite (`npx tsx scripts/run-evals.ts`) before/after on the default roster
  model; review LangSmith `tova-dev` traces for any case that shifts. (Semantic cases that
  need judgement — "invites intent without reflexive clarification", "closes conversations
  cleanly" — are not deterministically gradable and are deferred to the evals backlog, the
  same posture #158 records for its semantic remainder.)
- No client surface; e2e chat specs are stream-mocked and unaffected.

## Owner decisions (settled here; flagged at the PR for veto)

- **Prompt size budget** — roughly 2× the pre-#263 prompt (~800 words), bounded.
- **State vocabulary location** — envelope intros; no separate state tag (v1 injects one
  state, already covered by the existing `<user:workspace>` intro).
- **Conversation-shape client follow-up** — none opened from this slice; the nudge is
  prompt-side only.

## Follow-ups

- **Calculator tool** — a dedicated arithmetic tool (mathjs number-only, locked down),
  filed as a separate slice; it will move arithmetic to the tools side of the prompt and
  repoint the `arithmetic-no-search` case at the tool.
- **Semantic eval cases** for the judgement-only clauses (intent invitation, clean
  conversation close) — needs an LLM-judge or a human review harness; not deterministic.
- **Weak-vs-strong connection state** in the retrieval envelope, if gate evals (#253
  follow-up) show the model needs the distinction.
- **Client "start fresh" affordance** — a separate product question; not opened here.

## Process log

- 2026-10-11 — slice opened on `feat/tv/263-workspace-prompt` (cut from
  `epic/251-workspace`): plan, owner decisions settled, constitution authored, unit pins
  added, `arithmetic-no-search` golden case added. `npm run ci` green (96 suites, 1194
  tests). Eval evidence: the default roster model (GLM-5.3-Flash on DeepInfra) returned
  `429 engine_overloaded` for every case — an environmental outage, not a prompt effect —
  so the suite was run on DeepSeek V4.1 Flash (DeepInfra) instead. Scores: `pass` for
  `what-time-is-it`, `manual-phone-number`, `handbook-split-sections`, and the new
  `arithmetic-no-search`; `partial`/`fail` on the rest. The web-search cases
  (`pm-announcements-web`, `benchmaxxed-evals-web`) and the GitHub case cannot pass in
  this environment — `BRAVE_API_KEY` is unset (the `web_search` tool cannot run) and no
  GitHub MCP server is wired — so their failures are environmental, not prompt regressions.
  The new prompt did not break tool use on any case.
- 2026-10-11 — owner review caught a real defect: the layer-4 list named **arithmetic** as
  weights-side, which is wrong — LLMs are unreliable calculators, and arithmetic is exactly
  the kind of thing that should be a tool. The phrase came straight from the ticket, and was
  transcribed without challenge. Fixed on this branch by dropping arithmetic from the
  "trust yourself" list; a **calculator tool** (mathjs number-only, locked down) is a
  separate follow-up slice that will add the tool and point arithmetic at it. The
  `arithmetic-no-search` case description was corrected to state the negative only (no
  reflex search/file read), not the wrong "comes from the model" claim.
- 2026-10-11 — the calculator follow-up (#283, `docs/done/plan-283-calculator.md`) landed on
  a branch stacked on this one: it adds the `calculate` tool (mathjs number-only, locked
  down), moves arithmetic to the tools side of the prompt, and renames the golden case
  `arithmetic-no-search` → `arithmetic-uses-calculator` (now asserting the tool is called).
  The case name in the entries above is the pre-rename name.
