# Plan — #288 Deploy/CI fragility: single-source the shared build

## Motivation

Per GitHub issue [alex-moon/tova#288](https://github.com/alex-moon/tova/issues/288),
a follow-up to the #257 monorepo move. Since #257 the build/install contract
between the workspaces, the Dockerfiles, and CI has been implicit: the rule
"`@tova/shared` must be built before the server runs or typechecks" was
re-remembered in each of `dev`, `typecheck`, and the backend Dockerfile. A
runtime import of `buildMongoUri` added after #257 (shared was previously
types-only, so the CJS emit elided every `@tova/shared` import) made a missing
`dist` a hard crash, and the e2e job — gated on client/e2e changes only — did
not catch a server-side break on the PR; it only failed on the push to `main`.

## Decisions

- **TypeScript project references (option b).** `apps/shared` is now
  `composite: true` and `apps/server` declares `references: [{ "path":
  "../shared" }]`. `tsc -b apps/server` builds shared first, then server — the
  ordering is a declared dependency in the build graph, not a prefix repeated
  in scripts. This keeps #257's "compiled boundary" decision intact (shared
  still emits `dist`; the server still consumes the declaration) and avoids
  option (c): direct source resolution via tsconfig `paths` still fails with
  TS6059 (`rootDir` must contain all program files) even under `--noEmit`,
  re-confirmed on TS 5.9.3.
- **`tsc -b` is the typecheck too.** Project references have no emit-free
  mode: `tsc -b --noEmit` fails with TS6310 ("referenced project may not
  disable emit"). `typecheck` therefore runs `tsc -b` and emits `dist`, which
  is gitignored and ignored by both ESLint (`**/dist/**`) and Prettier
  (`dist/`). Build output is incremental, so the emit cost is near-zero after
  the first run.
- **`tsBuildInfoFile` lives in `dist/`** (`dist/tsconfig.tsbuildinfo`). The
  `tsc -b` default writes `apps/*/tsconfig.tsbuildinfo` next to the config,
  which is neither gitignored nor cleaned; pointing it into `dist` keeps the
  tree clean.
- **`dev` still builds shared explicitly.** The dev server runs from source via
  `tsx`, so it cannot use the server's build; it needs shared's emitted `dist`
  at runtime and calls the shared package's own `build` script. This is the one
  place the graph cannot help, and it invokes the single build definition
  rather than restating `tsc` flags. `typecheck` and Docker no longer name
  shared at all.
- **Docker server stage uses the graph.** `RUN npm run build -w apps/server`
  replaces the explicit `shared && server` pair; the composite reference pulls
  shared in. The `--ignore-scripts` install strategy is kept: there are no
  workspace `prepare` scripts (a #257 decision), so the trap that made
  `--ignore-scripts` dangerous (npm still runs a workspace `prepare` before its
  sources are copied) does not apply, and scoped installs intentionally exclude
  root devDependencies.
- **e2e runs on server/shared changes.** The `.github/workflows/ci.yml`
  changed-area detector now sets `e2e=true` for `apps/server/*` and
  `apps/shared/*`, not just `apps/client/*`/`e2e/*`. The e2e job starts the dev
  stack (server + Mongo + client) and the auth specs exercise the server, so
  this is the gate that would have caught the original break. Trade-off: more
  e2e minutes on backend PRs, accepted because a broken dev stack is exactly
  the failure mode this ticket exists to stop.
- **Contract documented in `AGENTS.md`** so the next agent does not rediscover
  the ordering rule.

## Done

- [x] Ticket + branch `fix/tv/288-shared-build-contract`
- [x] Plan doc
- [x] `apps/shared` composite; `apps/server` project reference
- [x] `build`/`typecheck`/Docker switched to the `tsc -b` graph
- [x] CI e2e gating extended to server/shared changes
- [x] Install/build contract documented in `AGENTS.md`
- [x] `npm run ci` green (exit 0; 97 suites / 1205 tests)
- [x] Dev-stack smoke: `rm -rf apps/*/dist && npm run dev` boots (health `{"status":"ok"}`, Mongo connected) with no manual build step
- [ ] PR opened

## Follow-ups

- The `dev` shared build is still a one-shot `tsc -b`; a `tsc -b --watch` for
  shared could remove even that, but it adds a watcher process for a change
  that only affects a runtime helper. Left as-is unless it proves painful.
