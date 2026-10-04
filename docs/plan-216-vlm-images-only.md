# Plan — #216 VLMs must only be used for images

## Motivation

Issue: https://github.com/alex-moon/tova/issues/216

Two rules:

- If no image is attached to the chat, a visual model must not be used.
- If an image is attached, a visual model must be used.

The second rule is already enforced: the image branch in `routeQuery`
(`routerService.ts`) restricts the large pool to `vision: true` rows and fails
loudly when none exist (#115). The first rule is the actual gap — the text
path consults tier/feedback but never excludes `vision: true` rows, so a
text-only turn can land on a VLM.

## Decisions

- **Enforce exclusion in `routeQuery`, not in the pool read.** `completionsPoolFor`
  is capability-general (it also serves the image pool, which requires
  `vision: true`). The text path is where "no image" is known, so filter there.
- **Filter both text pools (small and large) to non-vision rows** before
  `orderPoolByFit`/pick. A `vision: true` row is excluded from text turns in
  both tiers; a row with `vision` unset/false stays eligible (only explicit
  `true` excludes). No schema change.
- **Fail loudly when filtering empties a tier.** Reuse the existing empty-pool
  error (`No eligible models configured for tier`), promoted to a dedicated
  `NoEligibleModelsError` so it escapes the classifier try/catch. Previously an
  empty small pool thrown inside the classifier block was misread as a
  classifier outage and silently rerouted to large, masking the config gap.
  The pooled impact was checked: the large tier has many text-only rows, so no
  seeded tier is emptied by this rule.
- **Image turn unchanged.** It already selects only `vision: true` large rows;
  the two paths cannot disagree because the image branch returns before the
  text filter applies.
- **AUX `files` vote and classifier error fallback still pick from the filtered
  pool**, so a vision row cannot sneak in via those paths either.

## Done

- [x] Filter `vision: true` rows out of the text small/large pools in `routeQuery`.
- [x] Promote the empty-pool error to `NoEligibleModelsError` and rethrow it
      from the classifier catch, so a filtered-empty tier fails loudly rather
      than silently rerouting.
- [x] Tests: text turn never picks a vision row (small, large, and
      classifier-error fallback); image turn still only picks vision;
      vision-only tiers fail loudly.
- [x] `npm run ci` green (75 suites, 1048 tests).

## Follow-ups

- None for the routing rule. Separately, the full server suite has a
  pre-existing parallel live-Mongo flake (reproduced on `main` without this
  change; `modelConfigService` / `markdownConversion`); not addressed here.

