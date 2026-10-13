# Plan — #288 Deploy/CI fragility: source-resolve `@tova/shared` in dev

## Motivation

Per GitHub issue [alex-moon/tova#288](https://github.com/alex-moon/tova/issues/288),
a follow-up to the #257 monorepo move. The build/install contract between the
workspaces, the Dockerfiles, and CI stayed implicit: the rule "`@tova/shared`
must be built before the server runs" was re-remembered in `dev`, `typecheck`,
and the backend Dockerfile. A runtime import of `buildMongoUri` after #257
(shared was previously types-only, so the CJS emit elided every `@tova/shared`
import) turned a missing `dist` into a hard crash, and the e2e job — gated on
client/e2e changes only — missed a server-side break on the PR.

PR #291 took option (b) (TypeScript project references) and stopped the crash,
but it did not remove the dev-time `dist` dependency: `dev` still ran
`npm run build -w apps/shared` before `tsx`, so the failure class was
remembered-around rather than designed out. The issue's Decisions (2026-10-13)
select option (c) instead.

## Decisions

- **Option (c): resolve `@tova/shared` to source in dev.** `apps/server/tsconfig.json`
  gains `paths: { "@tova/shared": ["../shared/src"] }` and drops `rootDir`, so
  `tsx watch` (the only dist consumer) and `tsc --noEmit` read shared's source.
  `rootDir` cannot coexist with the path mapping: `tsc --noEmit` still fails
  TS6059 ("File is not under 'rootDir'") on TS 5.9.3 — verified by probe — so
  the mapping and `rootDir` live in different configs.
- **The emit path keeps a paths-free build config.** `apps/server/tsconfig.build.json`
  extends the base, overrides `paths: {}`, and sets `rootDir: "src"` + `outDir`.
  Shared source cannot enter an emitting program, and the project reference to
  `../shared` builds shared first. `Dockerfile` server-builder stays on
  `npm run build -w apps/server`.
- **`typecheck` is `tsc --noEmit` again.** With source resolution there is no
  need to emit `dist` to typecheck; `npm run typecheck` reads source and writes
  nothing.
- **`dev` no longer builds shared.** The prefix added by the #291 stopgap
  (`5cf2995`) is deleted; a clean clone runs the stack with no build step.
- **Drift test pins the source-resolution points.** A test reads the four legs
  (client Vite alias, client `tsconfig.app.json` paths, server `tsconfig.json`
  paths, Jest `moduleNameMapper`) and asserts each maps `@tova/shared` to
  `apps/shared/src`, so the legs cannot diverge again — same house pattern as
  `auth.contracts.test.ts` / `theme.inline.test.ts`.
- **e2e gating flips to default-on with an inert-path denylist.** e2e runs
  unless *only* provably-inert paths changed (`docs/**`, `*.md`, `.opencode/**`,
  `Dockerfile`). The old allowlist failed open: a new/unknown path silently
  skipped e2e, and the lockfile mapped to `server` but never `e2e`. Dockerfile
  is inert for e2e because the job boots the dev stack from source and never
  builds images.
- **`--ignore-scripts` installs kept; no workspace lifecycle scripts.** There
  are no workspace `prepare` scripts (#257 decision), so the trap is dormant.
  The drift test pins this rule too.

## Done

- [x] Ticket + branch `fix/tv/288-shared-source-resolution`
- [x] Plan doc
- [x] Server tsconfig split (dev/typecheck paths + paths-free build)
- [x] `dev` shared-build prefix removed; `typecheck` back to `--noEmit`
- [x] Drift test for the four resolution points
- [x] CI e2e gating default-on denylist
- [x] Contract documented in `AGENTS.md`
- [x] `npm run ci` green (98 suites / 1212 tests)
- [x] Dev-stack smoke on a clean `dist` (`rm -rf apps/*/dist && npm run dev` →
      health `{"status":"ok"}`, client 200, no shared `dist` written)

## Follow-ups

- Project references (#291 option b) are kept for the emit graph; the issue
  noted them as optional polish. If they are later removed, `apps/shared` need
  not stay `composite`.
