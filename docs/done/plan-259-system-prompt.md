# Plan #259 — System prompt: encode the dogfooded anti-sycophancy stance

## Motivation

The owner's latest live dogfooding session ("Personal journey and life
reflections", 2026-10-09/10) turned into a product conversation mid-thread, and
the model independently held a non-sycophantic stance — pushed back, held the
push without hedging, and did not smooth it out when the owner flagged it. That
stance is what Tova should have by default rather than by luck. See GitHub issue
[alex-moon/tova#259](https://github.com/alex-moon/tova/issues/259).

The existing `SYSTEM_PROMPT` already had the skeleton — "supportive of the
person, not automatically of every idea", the no-templated-reassurance rule, the
emotional-weight paragraph. It lacked the *stance* layer: push-and-hold, quick
forgiveness, and earned agreement. The ask is a **merge, not a rewrite**.

## Decisions

- **Merge, not rewrite.** Add the stance as prose appended to the existing
  clauses; change none of the existing machinery (per-user custom instructions,
  envelope delimiters, ZDR semantics, routing). Prompt text only.
- **Specify the stance, not the behaviours.** "Push back when the user is wrong"
  would produce contrarian-performance or post-push apologising. The prompt
  states the disposition — hold attention on what is actually said including
  what is avoided; push once, fully, let it stand, no same-breath softening, no
  re-litigating unless reopened — and lets the model judge.
- **Forgiveness is a positive behaviour, not an absence.** The failure class to
  avoid is punishing a person for responding imperfectly to a push, not pushing
  too hard. Name a deflection at most once, without charge, then follow them.
- **Dispositions generalise; conditions fire wrongly.** No mechanical trigger
  table ("when the user does X, do Y").
- **No explicit betterment agenda.** The person being improved by the
  conversation stays an emergent property; an explicit betterment agenda is the
  self-help-app voice, its own sycophancy.
- **Stance before the brevity rule.** The brevity rule stays, but the stance
  sentences sit before it so a held push is not trimmed into blandness — some of
  the best moments in the dogfood thread were long turns.
- **Anti-sycophancy is warmth-direction, not harshness.** Agreement is a
  conclusion, not a courtesy; when disagreeing, disagree like someone staying
  for pudding afterwards.

## Done

- [x] `promptAssembly.ts`: extend the "say so kindly and directly" clause with
      the push-and-hold stance and the earned-agreement sentence (recs. 1, 3).
- [x] `promptAssembly.ts`: fold the forgiveness clause and the
      turn-care-toward-real-people line (plus the no-disclaimer-botany note)
      into the emotional-weight paragraph (recs. 2, 4).
- [x] `promptAssembly.test.ts`: pin the stance phrases, their ordering before
      the brevity rule, and the absence of a mechanical trigger table.
- [x] `cases.ts` / `evalRunService.ts`: fix the `@repo:README.md` golden-case
      marker to `@repo:../README.md` after the #257 monorepo move (the eval
      reader's root is `apps/`, not the git root) — exposed while running the
      eval suite for verification; `defaultReadRepoFile` exported so a
      regression test can resolve every marker against the real reader.
- [x] `cases.test.ts`: pin every `@repo:` marker against the real repo reader
      so a silently-broken path cannot wait for the next live run to surface.
- [x] `npm run ci` green (branch tests pass; the 7 failures are pre-existing
      OCR/PDF-rasterisation environment failures, in files this branch does not
      touch).

## Follow-ups

- Optional (evals backlog): add a golden case pinning the stance — a prompt
  that invites hedging, graded for push-and-hold — so the stance is
  regression-covered like everything else.

## Verification

- `npx tsx scripts/run-evals.ts` before/after on the default roster model
  (#236); review LangSmith `tova-dev` traces for any case that shifts.
- `npm run ci` (server lint/format/typecheck/test, client lint/format/test/build).
- No client surface; e2e chat specs are stream-mocked and unaffected.
