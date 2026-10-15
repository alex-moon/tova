# Plan: #322 — Management commands entrypoint

Status: implemented; ready for review (archived per the workflow's ready-for-review trigger).

## Motivation

Operational/diagnostic tasks live as one-off `scripts/*.ts` (mongo.ts snippets,
eval compare, loki). The owner asked for a Django-style `manage.ts` inside the
backend app (#322) — a discoverable subcommand entrypoint with shared setup
(env, Mongo) instead of ad-hoc scripts.

## Decisions

- **Minimal shape**: `manage.ts` is an argv router over a flat registry
  (`name → { description, run(args) }`) in `manageCommands.ts`. No class
  hierarchy, no arg-parser dependency, no lifecycle hooks, no plugin
  discovery.
- **Driver-level, not app-level**: commands use the raw `mongodb` driver +
  shared `buildMongoUri` (the `scripts/mongo.ts` pattern), NOT the server's
  mongoose/config stack — keeps the CLI light and side-effect-free. Relative
  import to shared source, matching the scripts convention (no `--tsconfig`
  flag dance in the npm script).
- **Seeded with two commands of real value today**:
  - `roster` — live roster readout: eligibility, per-(model, provider)
    windowed TTFT (#320), cool-offs. Replaces hand-rolled `mongo.ts`
    snippets for the routing diagnostic.
  - `probe:image-tools` — the #318 verification probe (image in tool message
    vs user message against both roster providers, generated fixture PNG,
    color-answer assertion). Re-runnable regression check for the upcoming
    #318 implementation. DeepInfra's expected tool-image rejection prints as
    expected behavior, not a failure; exit code reflects only real regressions
    (user-image path or fireworks tool-image path failing).
- **Non-goals**: migrating existing `db:*`/`logs` scripts (working, guarded —
  churn without need); any command beyond the two above until needed.

## Done

- [x] `manage.ts` entry + `manageCommands.ts` registry
- [x] `roster` + `probe:image-tools` commands
- [x] `npm run manage -- <command>` wrapper
- [x] Registry/formatting unit test
- [x] `npm run ci` green

## Notes from implementation

- The probe uses owner-provided fixture images (moved to
  `apps/server/src/services/fixtures/`): red/blue 8×8 PNGs (two colors guard
  against lucky pattern matching) and kitten.jpg (real photo, content
  recognition). `bike-snow.jpg` is committed for the #318 golden-path tests.
- Live-model perception is noisy (one run described the blue square as "solid
  dark red", the next named it correctly), so each probe case gets one retry
  before it counts as a failure; expected rejections (DeepInfra tool-message
  images) don't retry.
- Verified live: both providers answer color/content correctly on user-message
  images; Fireworks sees tool-message images (200 + "Red"); DeepInfra rejects
  them at the schema level (422, expected — the #318 design consequence).
