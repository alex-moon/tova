# Plan — #354: image-tools probe hard cases (whiteboard, street) + per-case prompt/attempts

## Motivation

[#354](https://github.com/alex-moon/tova/issues/354), salvaging a follow-up to
[#322](https://github.com/alex-moon/tova/issues/322). A hardening commit
(`8d65951`) was pushed to `feat/tv/322-manage-commands` 36 minutes after PR
#323 merged and never landed. It extends the `probe-image-tools` manage
command with harder perception cases; without it the probe only checks trivial
color recognition.

## Decisions

- **Replay the orphaned commit as-is, path-rewritten.** The commit was made
  against the pre-#344 layout; all paths move `apps/server/src/` →
  `apps/server/src/main/`. Code, fixtures, and tests are taken unchanged.
- **Drop the archived plan-doc hunk.** `docs/done/plan-322-manage-commands.md`
  was edited after #323 merged, so that hunk does not apply; the historical
  record stays as merged.
- **Per-case `prompt` and `attempts`.** The single hardcoded question becomes
  a per-case field; the hardcoded `attemptsAllowed = 2` becomes per-case with
  default 2. Hard cases (whiteboard handwriting, busy street scene) declare
  `attempts: 3` because live-model perception on them is noisier.

## Done

- [x] Cherry-pick `8d65951` with the path rewrite (code, two fixtures, tests).
- [x] `npm run ci` green.

## Follow-ups

- None.
