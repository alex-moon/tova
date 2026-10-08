# Plan — #246 Delete the dead ProviderRouting model and collection

## Motivation

`ProviderRouting` (`src/server/models/ProviderRouting.ts`) is tier-era dead code
surfaced as a follow-up in `docs/done/plan-roster.md` (#235 notes). Ticket:
`alex-moon/tova#246`.

Evidence:

- No runtime reader remains. `rg -n "ProviderRouting" src/ migrations/ scripts/`
  returns only the model's own definition, historical comments
  (`inferenceService.test.ts`, `ModelRoster.ts`, the roster seed migration), and
  docs.
- #233 kept the model because the tier path still referenced it; #235 moved cost
  onto `ModelRoster` provider prices, dropping every `ProviderRouting` read
  (`traceStatsCost`, `sessionCostService`); #234 reworked admin `/models` onto
  the `modelroster` collection.

## Decisions

1. **Delete the model file outright.** Nothing imports it; the collection is
   never read by the app.
2. **Drop the legacy `providerroutings` collection via a migration.** The
   collection still exists in deployed and local databases. A forward-only
   migration drops it so the dead data does not linger. `down` is a guard no-op:
   tier-shaped rows cannot be reconstructed (their seed migrations were deleted
   in #233), so there is nothing meaningful to restore.
3. **Leave the handful of historical comments alone.** The `ModelRoster.ts` and
   seed-migration comments are accurate history ("the roster replaces the
   tier-shaped rows"); editing them adds churn without value.

## Done

- [x] Delete `src/server/models/ProviderRouting.ts`.
- [x] Add migration dropping the `providerroutings` collection.
- [x] Confirm no dangling import (`rg ProviderRouting src/ migrations/ scripts/`).
- [x] `npm run ci` green (87 server suites / 1073 tests; 18 client suites /
      242 tests). Migrations run clean on a fresh scratch DB: no
      `providerroutings` collection, `modelroster` seeded with 3 rows.

## Follow-ups

- None. This closes the last open item of the roster epic.
