# Plan: #371 Honesty guard

## Motivation

[#371](https://github.com/alex-moon/tova/issues/371): assistant turns sometimes narrate tool
results they never executed (measured in the formsatz "Blog: models" session). The guard
classifies each settled assistant turn post-hoc, flags fabrication, self-corrects at the next
turn boundary, and gives the user a one-click retry.

## Decisions

- **Fire-and-forget post-turn aux call**, mirroring the house aux pattern (`metricsService`,
  `maybeReviseSubtitle`): no turn latency, no blocking, no prefilter.
- **Skip the aux call when tools executed.** The flag rule is "asserts tool use with zero
  executed tools"; a turn with executed tools can never meet it, so the call is deterministically
  skippable — cheaper than asking the model every turn.
- **Flag subdoc on Message**, shape like `feedback`: `honesty: { flagged, reason, checkedAt }`.
  Absent = not assessed (aux call failed or parse failed); no synthetic false.
- **Turn-boundary correction** rides prompt assembly: when the newest assistant message in
  history is flagged, a bracketed corrective note is appended to the current user turn's prompt
  content (same mechanism as the provenance line — never persisted, never shown). ZDR turns
  carry no flags (nothing is stored), which is consistent.
- **Retry affordance is client-only**: the flagged bubble renders a badge and a "Retry for real"
  button that resends the preceding user message verbatim. The server-side turn-boundary note
  supplies the correction — no client-side instruction text needed.
- **Parsing** stays a small tolerant JSON-object read (house style until #368 migrates aux
  generation to structured output; that ticket will absorb this call site).

## Done

- [x] `honestyGuardService.ts`: classifier call + tolerant parse + fire-and-forget persistence
- [x] `Message` schema: `honesty` subdoc
- [x] Both chat routes fire the guard after `assistantMessage.save()`
- [x] Turn-boundary corrective note in prompt assembly (flagged newest assistant → note on current user turn)
- [x] Client: badge + "Retry for real" on flagged messages; `Message` type gains `honesty`
- [x] Unit tests (parse, persistence, note injection) + route integration tests (flagged / clean / tool-turn skip)
- [x] `npm run ci` green; e2e responsive suite green (60/60); badge verified at 375px in a real browser

## Verification notes

- Route tests cover: flagged verdict → persisted flag + `honesty` SSE frame *after* `done`
  (so `done` never waits on the guard); tool turn → guard skipped entirely; flagged newest
  assistant → corrective note appended to the current user turn's prompt.
- Visually verified against the real "Blog: models" session locally: warning badge
  "Described actions it didn't perform" + "Retry for real" render within a 375px viewport with
  no horizontal overflow (the seed fixture was removed afterwards).

## Follow-ups

- #368 will migrate this classifier to Mastra structured output.
- Possible future: flag turns claiming tool *types* they didn't use when some other tool ran
  (deliberately out of scope here).
