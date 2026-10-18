# Plan — #394 eval infra hardening batch

## Motivation

[#394](https://github.com/alex-moon/tova/issues/394), from the #382 audit. The eval
runner/scheduler has nine independent defects: a silently ignored provider env, a
check-then-create lease race, a hung stream that permanently wedges the schedule,
stale fixtures after a crashed run, crashed runs mislabelled as graded failures,
silent catch-alls, a stage-3 eval that never embeds its corpus, a module-global
side channel, and an unboundedly growing LangSmith dataset.

## Decisions

- **Provider config errors throw.** `resolveScheduledModels` honours any wired
  provider and throws a new `EvalConfigError` on an unknown one — model+provider
  resolve as one unit, so a typo can never strand the configured model on the
  default backend. The admin "Run now" route maps `EvalConfigError` to 400.
- **Lease = unique partial index.** A unique index on `{status: 1}` filtered to
  `status: 'running'` enforces the existing "one global running row" invariant
  atomically (the pre-check stays as a fast-fail seam). E11000 on insert maps to
  `EvalRunBusyError`. A migration flips stranded running rows (a deploy kills
  in-flight runs, so all of them are stranded) before building the index. The
  copy-pasted `resolveRunDeps` collapses into a shared `resolveLeaseDeps` +
  `writeEvalLease` in `evalRunService`, reused by the memory runner.
- **Wedge fixes stay simple.** Per-case `AbortSignal.timeout` (5 min) plus a
  suite wall-clock cap (90 min, under the 2 h stale-lease window) via remaining-
  budget signals — no `AbortSignal.any` needed. The scheduler reclaims stale
  leases per tick (not just at boot) and logs every swallowed error.
- **Run-level vs case-level errors keyed on graded successes.** A thrown case is
  `error` when no case in that model's run graded (provider outage) and `fail`
  when other cases in the same run succeeded. The `models.length > 1` heuristic
  is gone.
- **`retrieve` returns diagnostics.** `runRetrievalEval`'s `retrieve` dep returns
  `{ slices, candidateCount? }` instead of the `lastCutDiagnostics` module
  global — no stale state across scenarios, and the identity check on the live
  default goes away.
- **Thrown cases flush after graded ones.** Per model, thrown cases are
  collected during the loop and appended (in case order) once the model's run
  completes, so the run-level `error` score can be decided on graded successes.
- **Fixtures are delete-then-insert.** `seedEvalSource` clears the eval user's
  assets before inserting, so a crashed run's stale rows cannot survive.
- **Memory dataset is delete-before-push.** `pushMemoryCorpusToLangSmith` deletes
  existing examples via `client.listExamples`/`deleteExample` when present, so
  re-runs replace instead of append.
- **Stage 3 embeds.** `runHelpfulnessEval` gains an `embed` dep defaulting to the
  same `defaultEmbedUser` as stage 2 (exported from `memoryEvalService`),
  degrading to BM25 with a logged error on failure — parity with stage 2.
- **Review round (pre-ready hardening).** Three holes found and closed on the
  same branch: (1) `resolveScheduledModels({ provider: 'groq' })` still leaked
  the deepinfra default model id — any wired provider hosting none of the fixed
  models now throws `EvalConfigError` unless `TOVA_EVAL_MODEL` is explicit
  (verified by probe before the fix). (2) The lease index could silently not
  exist: a Mongoose `autoIndex` build fails permanently when a DB carries ≥2
  stranded `running` rows (exactly what the pre-lease TOCTOU produces), and
  nothing ever retried — `reclaimStaleEvalRuns` now rebuilds the lease index
  after reclaiming, so the boot/tick self-heal path also heals the index.
  (3) A suite-cap-truncated run was indistinguishable from a complete one; the
  runner now logs when the cap stops cases. Route tests pin the 400 mapping.

## Done

- [x] `resolveScheduledModels`: wired provider honoured, unknown → `EvalConfigError`
- [x] Atomic eval lease: partial unique index + migration + E11000 → `EvalRunBusyError`
- [x] Shared `resolveLeaseDeps`/`writeEvalLease`; memory runner reuses them
- [x] Per-case abort timeout + suite wall-clock cap in `runEvalSuite`
- [x] Scheduler: per-tick reclaim, all catch-alls log
- [x] `seedEvalSource`: deleteMany + insert
- [x] Error-vs-fail keyed on graded successes, not model count
- [x] `runHelpfulnessEval` embeds between seed and retrieve
- [x] `retrieve` dep returns `{ slices, candidateCount? }`; global removed
- [x] Memory dataset delete-before-push
- [x] Review round: provider/model unit throws when the provider hosts no fixed model
- [x] Review round: reclaim rebuilds a missing lease index (autoIndex self-heal)
- [x] Review round: suite-cap trip logs; 400 mapping pinned by route test
- [ ] `npm run ci` green

## Follow-ups

- None yet.
