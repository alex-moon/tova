# Plan — #220 Client mobile: fix /admin mobile layout, de-drift and gate the responsive e2e suite

## Motivation

The `AGENTS.md` "Client UI work" section declares mobile-first behavioural policy.
This ticket makes the aspirational parts real, per GitHub issue [alex-moon/tova#220](https://github.com/alex-moon/tova/issues/220):

1. `/admin` is a phone surface (the owner quick-views LangSmith/Grafana from it)
   but its dense tables and tab strip are not usable at 375px.
2. The responsive e2e suite already runs both `mobile` and `desktop` projects but
   is not in the gate and had drifted stale assertions.
3. Nothing mechanically catches a route that overflows horizontally at phone width.

## Decisions

- **Responsive tables, not a horizontal-scroll affordance.** `AGENTS.md` treats an
  overflow affordance as the floor. The admin is a phone surface, so dense tables
  (Users, Models, Graph entities, Access/PATs, Traces, Models-errors, LangSmith
  model-stats) render as stacked label/value cards under `md` and keep the
  `<table>` at `md` and up. This is a presentation change scoped to the tables,
  not a broader admin redesign (explicitly out of scope).
- **Shared helper, one breakpoint.** A single `md` breakpoint drives every table.
  Cards are produced from the same row data as the table, so testids and copy stay
  in one place per section. Card values use a `minmax(0, 1fr)` grid track so a long
  unbroken token (e.g. an email) wraps instead of clipping the card edge on the
  narrowest phones.
- **Tab strip stays a horizontal scroller with a real affordance.** The nav keeps
  `overflow-x-auto` (never wraps) but gains an edge-fade cue so clipped tabs are
  discoverably scrollable instead of looking broken mid-word.
- **e2e fixture password is `password`.** `db:password` resets every user password
  to the shared literal `password` (AGENTS.md), so `e2e/playwright.config.ts` must
  default `E2E_PASSWORD` to `password`. Inheriting `ADMIN_PASSWORD` from the local
  `.env` shadowed the fixture and made auth specs fail locally.
- **CI gate, changes-scoped.** `test:e2e` runs in CI only when `src/client/**` or
  `e2e/**` changed (issue #141 free-tier minutes). It reuses the existing
  `changed` job's path detection and the repo's no-third-party-actions convention.
- **Overflow smoke is document-level plus scoped clipping.** `responsive.spec.ts`
  asserts no document horizontal overflow and no viewport-clipped element without
  a scrollable ancestor, across `/`, `/profile`, `/files`, `/admin`, at phone width.
  It page-mocks auth so it never touches seeded state.

## Done

- [x] De-drift `e2e/profile.spec.ts` (Incognito copy, #144) and `e2e/assets.spec.ts`
      (master/detail selection, #197).
- [x] Add `e2e/responsive.spec.ts` overflow smoke.
- [x] Fix `e2e/playwright.config.ts` password default to the documented fixture.
- [x] Make `/admin` Users/Models/Graph/Access tables legible and operable at 375px.
- [x] Make Traces (`AdminLangsmithView`) tables legible at 375px.
- [x] Add a scroll affordance to the admin tab strip.
- [x] Wire `test:e2e` into `.github/workflows/ci.yml`, gated on client/e2e changes.
- [x] Visually verify `/admin` at 375px with `playwright-cli` (and at 320px).
- [x] `npm run db:password && npm run test:e2e` green; `npm run ci` green.

## CI-red resolution (post-closeout)

PR #229's first post-closeout run reported `ci` FAILURE (and `ci-gate` FAILURE by
dependency). Reproduced from the run log: `modelConfigService.test.ts` ›
`capability matching (#94)` › `rules out models flagged tools:false from the
completions pool`. This was called a "pre-existing flake", but it is deterministic
in cause:

- `openai/gpt-oss-20b` is the small/deepinfra seed **and** the guard/groq seed
  (`DEFAULT_MODEL_ENV.small` and `GUARD_ENV` share that fallback).
- The test's `findOneAndUpdate({ model: 'openai/gpt-oss-20b' }, …)` omitted
  `tier`/`provider`, so Mongo updated one of the two matching docs arbitrarily.
- `ensureSeed` inserts concurrently (`Promise.all`), so natural insertion order —
  and therefore which doc the unscoped match hit — is nondeterministic. When it hit
  the guard row, the small pool still held a `tools:true` gpt-oss-20b and the
  assertion failed exactly as CI showed.
- Fix: scope both the flip and its `finally` restore to
  `{ provider: 'deepinfra', model: 'openai/gpt-oss-20b', tier: 'small' }`.
- Verified: probe confirms two docs match the old filter; full server suite
  1060/1060, `npm run ci` exit 0. This touches server test code only; the client
  branch's diff to `src/server/**` remains empty.

## Follow-ups

- The `ScrollablePanel` primitive's mobile behaviour is deferred (out of scope; to be
  checked when it is next touched).
- Deeper interactive parity for Traces/Graph on touch (tap-to-expand gestures) beyond
  the legibility/operability fixed here is not addressed.
