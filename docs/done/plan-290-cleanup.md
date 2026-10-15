# Plan — Cleanup: stale comments and dead code (#290)

## Motivation

Code-hygiene sweep requested by the owner (GitHub issue #290). Comments have
accumulated across the codebase and some are stale — most visibly path
references left over from the #257 monorepo move (`src/server/...` etc. now
live under `apps/*/src/...`), plus comments naming files, helpers, or plan docs
that no longer exist. Some exports have no reference anywhere. This ticket
removes that drift without changing behaviour.

## Decisions

- **Scope is source, not history.** Archived plan docs (`docs/done/**`) and the
  static delivery log (`docs/progress.md`) keep their original wording: they are
  historical records, and rewriting their paths would falsify what was true when
  they were written. `docs/overview.md` is current-state documentation, so its
  paths were corrected.
- **Plan-doc pointers updated to `docs/done/`.** Code comments that pointed at
  `docs/plan-*.md` now point at `docs/done/plan-*.md`, where those docs actually
  live. `scripts/iteration.sh` was left alone: it creates *new* plans, which do
  belong in `docs/`.
- **Dead code removed only where provably unreferenced.** Each candidate was
  grepped repo-wide (source, tests, scripts, e2e, configs) with zero hits
  outside its own declaration before removal.
- **Manual scripts kept.** `scripts/iteration.sh` was deliberately restored in
  commit `6f71fda`; `scripts/smokeImageTurn.ts` is a manual diagnostic. Neither
  is imported by design, so neither is "dead" — see Follow-ups.
- **No behaviour change.** Removals are unused type aliases, unused constants,
  and one feature-gate function nothing called.

## Done

- [x] Old-path comments updated to the `apps/*` layout across `apps/**`,
      `scripts/`, `jest.config.js`, `.gitleaks.toml`, `README.md`, and
      `docs/overview.md`.
- [x] Stale references to removed things fixed: `routerService` / tier
      coexistence (`rosterConfig.ts`), `libraryBlockFor` (`promptAssembly.ts`),
      `disableModel` / `listByTier` / `SEED_ENTRIES` (`rosterConfig.ts`), the
      removed in-memory log ring buffer (`ErrorLog.ts`), `mastraService.test.ts`
      (`mastraAgentStub.ts`, `inferenceService.test.ts`),
      `scripts/eval-classify-models.ts` (`run-evals.ts`), and two removed docs
      pointers in `e2e/`.
- [x] `README.md` inaccuracies fixed: `install:all`/`postinstall` (removed),
      `dist/index.js` → `dist/main.js`, root `src/index.ts` entry → the real
      `apps/server/src/main.ts`, and the retired entity-extraction aux call.
- [x] Plan-doc pointers in code moved to `docs/done/`.
- [x] Dead exports removed: `CATEGORIES` (`modelErrorTally.ts`),
      `ErrorLogDocument` (`ErrorLog.ts`), `ModelRouteErrorDocument`
      (`ModelRouteError.ts`), `SafeBrowsingCacheDocument`
      (`SafeBrowsingCache.ts`), `isAssetJobPollerRunning` (`assetJobService.ts`),
      `CreatePatRequest` / `LoginCredentials` / `RegisterCredentials`
      (`validation.ts`), `FILES_VOTE_PROMPT` (`enrichmentService.ts`),
      `ProviderName` (`modelConfigService.ts`), `ROSTER_PROVIDERS`
      (`rosterConfig.ts`), `LoginRequest` / `RegisterRequest`
      (`shared/contracts.ts`), `rosterRacingEnabled` (`racingService.ts`).
- [x] `npm run ci` green.

## Follow-ups

- `scripts/smokeImageTurn.ts` is unreferenced (not in `package.json`, CI, or
  AGENTS.md). It is a manual #115 smoke test, so it was kept; the owner may
  want it wired into docs or deleted.
- `scripts/iteration.sh` is a manual operator tool restored deliberately in
  `6f71fda`; left in place.
