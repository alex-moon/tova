# Plan — #419 Flash cards / pop quiz

Branch: `feat/tv/419-flash-cards`

## Motivation

[#419](https://github.com/alex-moon/tova/issues/419): a fun admin game that quizzes the
owner on how Tova's backend actually works — backend pipeline only. Coverage should match
the tests but at a higher level: one question captures one "idea" about the pipeline,
crossing files as needed. Owner additions: multiple choice; persist right/wrong; surface
wrong-most questions more often (statistically weighted but still random); shuffle option
order; clear Correct/Incorrect feedback; fast loop (answer → verdict → next question).
Explicitly janky-tolerant, single-user.

## Decisions

- **Client-only, zero server surface.** The question bank is a static TS module in the
  client; answer stats persist to `localStorage` (`tova-quiz-stats-v1`). Single user, no
  migrations, no auth/API/tests on the server; stats survive reloads. Cross-device sync is
  deliberately not built.
- **A new admin tab** ("Quiz") following the `AdminEvalsView`/`AdminLangsmithView`
  component pattern, wired into `AdminView`'s section union + tab strip. Admin-only by
  construction (the whole route is admin-gated).
- **Weighted sampling.** `weight = 1 + max(0, wrong − correct) × 3` per question: every
  question keeps nonzero probability (still random), net-wrong questions get ~3× more
  likely per net miss, and answering correctly as often as wrongly normalizes the weight —
  mastered questions stop dominating. The last 3 served questions are never repeated.
- **Options shuffled at render time** from a canonical order; the answer index travels
  with the option.
- **Phone-first loop.** Full-width option buttons, verdict banner (Correct/Incorrect +
  one-line explanation), one Next action (tap button / Space / Enter); keys 1–4 answer on
  desktop. Session streak + all-time accuracy in the header; stats reset affordance.

## Question bank

Static, hand-authored from `apps/server/src/main` (constants read from `modelDefaults.ts`,
`config/index.ts`, `taskProcessor.ts`, `taskSequencer.ts`, `workspaceRetrievalService.ts`,
`promptAssembly.ts`, `index.ts`) and the plan docs in `docs/done/`. Categories: routing &
racing, task runtime, workspace memory, aux model & honesty guard, system prompt, metrics
& privacy, redaction & observability, files & storage, connectors, bootstrap & background.
Distractors reuse real retired mechanisms (roster scoring, cool-offs, forced
`toolChoice`) so wrong answers are plausible. Each question carries a one-line
explanation. Owner constraints from play: player-facing copy references modules/mechanisms
only — never tickets, tests, or the dev process; the rationale lives in `explain`, never
in the option text; and options stay length-balanced so the answer is not guessable by
size (all pinned by the bank-integrity test).

## Done

- [x] Question bank module (103 questions, typed, grouped by category)
- [x] `AdminQuizView.tsx` — weighted pick, shuffle, verdict + explanation, next loop,
      localStorage stats, streak/accuracy header, reset
- [x] Wired into `AdminView` as a tab
- [x] Client tests: bank integrity (unique ids, 4 options, valid answers), sampler
      weights/recent-guard/skew, shuffle correctness/reordering, answer flow
      (right/wrong/stats), next, reset (12 tests)
- [x] `npm run ci` green (exit 0); e2e responsive suite green (60/60, `/admin` included)
- [x] Playwright phone-viewport check (375px): question card, both verdict colours,
      explanation, Next, stats persisting to localStorage, Space advance; no horizontal
      overflow (`scrollWidth === innerWidth`)
- [x] Owner sign-off on UI; ticket/process references culled from player-facing copy;
      test-flavored questions replaced with functionality ones

## Follow-ups

- None yet.
