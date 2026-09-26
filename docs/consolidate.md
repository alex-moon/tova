# Consolidation sweep — 2026-09-26

Two jobs (this file is the running log for the session):

1. Audit all open issues against delivered work on `main`; close the ones that
   are obviously already shipped.
2. Complete #168 and #170 and merge to `main` — one branch, since they touch the
   same pool machinery — closing the stale WIP PRs along the way.

## 1. Issue audit (verdicts)

Survey of all 8 open issues against `main` @ f8e8378:

| Issue | Verdict | Evidence on main | Action |
|---|---|---|---|
| #167 Code blocks should not be one line | **Delivered** by PR #172 (1de03a7) | `index.css` `.markdown-body pre code { white-space: pre-wrap }` + `[&_pre]:max-w-full [&_pre]:overflow-x-auto` on the message body — wrap by default, horizontal scroll only when a single line overflows | Close |
| #169 Route to large models more | **Delivered** by PR #176 (f8e8378) | guard-only routing, large-by-default boundary; the proposal the ticket asked for was made and shipped in the same PR | Close |
| #171 Deterministic document splitting | **Bulk delivered** by PR #165 (e9cb083, ticket #159) — a day before #171 was filed | `documentUnits.ts`: per-page PDF units with 1-indexed page labels, per-section md/html units, computed at extraction time. Only #171's extra delta (page numbers from PDF metadata) is not obviously covered | Comment, leave open for Alex's call |
| #168 Model errors should disable the model | Partially on main via WIP PR #173 (4ade2f3); full deliverable sits unmerged in PR #177 | Completing below | Close when the consolidated PR merges |
| #170 More models | Full deliverable sits unmerged in PR #180 (complete, green, mergeable) | Completing below | Close when the consolidated PR merges |
| #166 Offline worker | Not started (no branch, no commit) | — | Leave open |
| #178 Rate limits should back a model off | Follow-up deliberately filed from #168's work; not delivered | — | Leave open |
| #179 Persistent log retention (Loki+Promtail) | Follow-up deliberately filed from #168's work; not delivered (an untested sketch exists on `feat/179-persistent-log`, unmerged) | — | Leave open |

## 2. #168 + #170 on one branch

Superseded artifacts being closed:

- PR #177 (`feat/168-model-errors`) — the full #168 deliverable, but based on
  pre-#176 `main` (its `routerService`/`chat` revert #169 phase 2) and conflicting
  with #175's error-log persistence. Closed in favour of the port below.
- PR #180 (`feat/170-more-models`) — complete, green, mergeable, but its work is
  folded into the same branch per the one-branch direction. Closed in favour of
  the same PR.

Branch: `feat/tv/168-170-model-pool`, from `main` @ f8e8378.

### Port plan

1. Merge `origin/feat/170-more-models` (clean): 14 new ZDR DeepInfra seed rows +
   migration `20260926000200-seed-more-models-routing.ts` + tests + plan doc.
2. Port #168 from `feat/168-model-errors` onto current `main`, keeping #176's
   guard routing intact:
   - `modelConfigService`: `AllModelsDisabledError` + lazy `isCoolingOff`;
     `readRows` returns all eligible rows; three-case `listByTier`
     (env fallback / env fallback / all-cooling-off → throw, no fallback);
     `disableModel` returns whether the cool-off write landed.
   - `modelFailover`: 429 never disables (fails loudly — #178 owns back-off);
     a failed cool-off write stops the loop with the original error.
   - `routerService`: pool reads via `Promise.allSettled`; cooling-off flags on
     `RouterConfig`; drained tier throws the all-disabled error only at pick
     time (healthy tier still serves); image turns + classifier-error fallback
     report all-disabled rather than a config gap.
   - `chat` routes: stream loop uses `MAX_ATTEMPTS`, skips disable on 429,
     stops on failed cool-off write; pre-stream all-disabled → 503 with the
     friendly message.
   - Client: 503 surfaces the server message verbatim; admin Models tab gains a
     cooling-off badge and a per-model error table.
3. **Lean diagnostics consolidation (OQ-7, resolved by the close-PRs
   direction)**: #168's separate `ModelErrorStat`/`modelErrorStatsService`
   mechanism is dropped. #175's `modelrouteerrors` tally (hooked at
   `inferenceService`, the single completion choke point) already records every
   failure shape; the admin error table is wired onto it instead. No second
   diagnostics collection, no double-counting.
4. Tests: port the #168 suites from PR #177, adapted to the lean diagnostics
   (no `modelErrorStatsService` mocks) and to #176's rewritten
   `routerService.test.ts`.
5. Docs: `docs/plan-168-model-errors.md` (new), #170's plan doc (via merge),
   `docs/progress.md` entries.
6. Gate: `npm run ci` must exit 0 before the PR.

### Progress log

- [x] Survey issues/PRs/branches; write plan above
- [x] Close #167, #169; comment on #171
- [ ] Branch + merge #170 work
- [ ] Port #168 server pieces
- [ ] Port #168 client pieces
- [ ] Port/adapt tests
- [ ] Docs (plan-168, progress.md)
- [ ] `npm run ci` green
- [ ] PR opened; #177/#180 closed as superseded
- [ ] Merged to main; #168/#170 closed
- [ ] Plan docs archived to `docs/done/`
