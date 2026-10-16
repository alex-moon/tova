# Plan — Split `main` from `test` (#344)

## Motivation

Tests currently live next to the code they exercise (`apps/server/src/**/*.test.ts`,
etc.). That co-location makes PR diffs noisy — a change to a source file and its
tests are interleaved, and reviewers cannot see the production change at a glance.

Adopt the common convention: production code lives under `src/main/`, tests under
`src/test/`, across all four apps (`client`, `server`, `shared`, `migrations`).

Ticket: https://github.com/alex-moon/tova/issues/344

## Target shape

```
apps/<app>/src/main/...   production source (was apps/<app>/src/...)
apps/<app>/src/test/...   test files (was apps/<app>/src/**/*.test.ts[x])
```

Test files mirror their original `src/` path under `test/`, e.g.
`apps/server/src/services/foo.test.ts` → `apps/server/src/test/services/foo.test.ts`.

`migrations` has no tests today; its source still moves under `src/main/` so the
convention holds uniformly.

## Decisions

- **Move source wholesale, tests in parallel.** Moving the whole source tree into
  `main/` keeps every relative import *between* source files valid unchanged. Only
  test files cross the `main`/`test` boundary, so only they need import rewrites.
- **Entry points move too.** `src/main.ts` → `src/main/main.ts` (server and client).
  The server build keeps `rootDir: src/main` + `outDir: dist`, so `dist/main.js`
  is unchanged (Dockerfile `CMD` untouched). Client `index.html` script src becomes
  `/src/main/main.tsx`.
- **Existing `src/test/` infra stays put.** The server's jest infra (setup, global
  setup/teardown, mastra stubs) and the client's `test/setup.ts` already live under
  `src/test/`; test files join them there. Imports of that infra from tests are
  rewritten to point back at it (`../test/muteConsole` → `../muteConsole`).
- **Shared resolution points move to `../shared/src/main`** in every leg: server
  tsconfig paths, client Vite alias, client tsconfig paths, Jest moduleNameMapper.
  Shared's `rootDir` is `src/main`, so its emit flattens to `dist/index.js` /
  `dist/index.d.ts` — package `main`/`types` are unchanged (only the source path
  moved).
- **`@/` client alias** re-points to `./src/main`.
- **Tests that compute paths from their own location** (`__dirname` /
  `import.meta.url`) get the extra level added: fixture dirs, `index.css`,
  `index.html`, and `REPO_ROOT` in the resolution contract test. Two production
  helpers that resolve repo-relative paths (`ocr.ts` TESSDATA_DIR,
  `evalRunService.ts` `defaultReadRepoFile`) also gain a level; `manageCommands.ts`
  fixtures and the production `client/dist` path are depth-neutral and untouched.

## Done

- [x] Server: source → `src/main`, tests → `src/test`, imports rewritten
- [x] Client: source → `src/main`, tests → `src/test`, imports rewritten, `index.html` updated
- [x] Shared: source → `src/main`, test → `src/test`
- [x] Migrations: source → `src/main`, run scripts updated
- [x] Configs: jest roots, server tsconfigs (`rootDir: src/main`), shared tsconfig, client tsconfig + vite, eslint, root/migrations package scripts
- [x] Cross-app importers updated (scripts, server `manageCommands.ts`, migrations `index.ts`)
- [x] `sharedResolution.contracts.test.ts` assertions updated to `src/main`
- [x] CI semgrep path updated
- [x] `npm run ci` green (114 suites, 1489 tests) and `npm run build` emits `apps/server/dist/main.js` + `apps/shared/dist/index.js`

## Follow-ups

- Stale path comments elsewhere in the tree (e.g. `apps/server/src/main/config/index.ts`
  still says `apps/server/src`) are left as-is; they are descriptive, not assertions.
  A repo-wide comment sweep is out of scope for this ticket.
- e2e was not run: the local `npm run dev` processes predate the move and the API
  server was down. The client production build (in `ci`) bundles the new
  `index.html` → `/src/main/main.tsx` entry, and the client unit suite passes.

