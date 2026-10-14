# Plan — #289 Workspace memory: gate evals and thresholds

Issue: [alex-moon/tova#289](https://github.com/alex-moon/tova). Epic: #251.
Branch: `feat/289-workspace-memory` (PR #303, WIP draft). Follow-up to #253
(merged #271); retrieval follow-ups: #293 (BM25), #294 (embeddings/vector).

This plan covers the **remaining** work on #289. The first increment (PR #301)
is **merged** on `main` as `5a9ecfa`; its plan doc is
`docs/plan-289-gate-evals.md` and its runner already exists under
`apps/server/src/evals/memory/`. This document re-plans from the ticket's "Next
steps" comment (2026-10-13) and must stay consistent with that doc. Where they
differ, this one is the forward plan.

> **Revision note (2026-10-14, plan-review pass 2).** This pass re-grounded the
> plan against the branch again and corrected four classes of defect:
>
> 1. **Factual command/flag drift.** T9 told the reader to run
>    `npm run evals:memory -- --all`, but `--all` does not exist and
>    `--helpfulness` **already** runs all three stages (the CLI always runs
>    stages 1–2, then adds stage 3 when the flag is passed). T9's
>    `WORKSPACE_MEMORY_ENABLED=1` is also unnecessary: neither
>    `runGateEval`/`runRetrievalEval` nor `runHelpfulnessEval` reads
>    `config.workspaceMemory`. Both are corrected below.
> 2. **Hidden task dependencies.** T5, T9 and T10 silently depended on T14/T15
>    (the hardening pass) and on each other. There is now an explicit
>    dependency order, and each dependency is a task, not an open question.
> 3. **"Single commit" claim contradicted the task bodies.** T14 bundled five
>    changes and T15 three; they are now lettered sub-tasks, one commit each.
> 4. **A stale sentence in the repo doc.** `docs/plan-289-gate-evals.md`
>    Decision 1 still says "The judge is not wired in this increment" while its
>    own Stage 3 section says "wired, not yet validated". The previous pass
>    called the doc drift "fixed"; it is fixed for the **numbers**, not for that
>    sentence. T0 now fixes it.
>
> Open questions that this pass newly surfaces (OQ20–OQ27) are queued on #289.
>
> **Revision note (2026-10-14, plan-review pass 3).** This pass tightened the
> plan on three axes and found one new material defect:
>
> 1. **A shared-eval-user clobber between the two suites (new, OQ28).** Both the
>    tool-use suite (`evals/mongoSource.ts`: `seedEvalSource`/`clearEvalSource`)
>    and the memory suite (`evals/memory/memorySource.ts`:
>    `seedMemoryScenario`/`clearMemoryCorpus`) seed and clear the **same reserved
>    `evalUserId`**. `clearMemoryCorpus` deletes every `Asset` for that user —
>    which is exactly the tool-use fixture set; `clearEvalSource` deletes every
>    `Asset` and the eval `User` — which is every memory fixture. T8 therefore
>    cannot run the two suites concurrently. Its default is now **strict
>    sequential execution**; whether to instead give each suite its own reserved
>    user is OQ28.
> 2. **Task/OQ decoupling.** Three tasks silently depended on an open question.
>    T8 depended on OQ26 (is stage 1 safe to schedule unattended?); T6/T7
>    depended on OQ27 (`countScores` kind-scoping); T10's stage-3 proposal
>    depended on OQ1. Now: T8 schedules **stage 2 only** by default (Mongo-only,
>    deterministic) with stage 1 contingent on OQ26; T6/T7 implement the D9
>    default (keep `countScores`, add a `kind` badge) so OQ27 is a confirmation,
>    not a blocker; T10 proposes the stage-3 bar from the T9 baseline with an
>    explicit "judge unvalidated" caveat, and only *ratification* waits on
>    T5/OQ1. See **Task dependency order**.
> 3. **Thin tasks fleshed out; an answered question moved out of Open
>    questions.** T0, T5, T9–T13 now state the exact edits, capture template and
>    deliverable. T1 gains an unconditional sub-task (record the refer-back
>    subtype; add adversarial fresh-ask negatives) so OQ12/OQ19 stop gating the
>    *corpus* work — only the *judgement* stays open. OQ7 (is substring
>    containment the right backbone?) is **removed**: the ticket fixes the
>    backbone ("assert the answer contains the expected fact"), so it is a
>    decision, not a question; only the normalisation residual (OQ22) remains.
> 4. **Doubt moved to Open questions, and a resolved doubt removed.** The
>    stage-3 model-identity gap (the responder and judge are not recorded, so a
>    helpfulness baseline is not reproducible) is now OQ29. Conversely, the
>    corpus-hash canonicalisation doubt was checked and closed:
>    `GATE_CASES`/`MEMORY_SCENARIOS` are plain JSON (strings/booleans/numbers/
>    arrays; verified in `types.ts`), so D15's hash is well-defined.
>
> New open questions (OQ28–OQ29) are queued on #289.
>
> **Revision note (2026-10-14, plan-review pass 4).** This pass read the shipped
> stage-3 code against the plan's own claims and found five defects — three are
> code/robustness gaps the plan hid, one is a task/OQ coupling, one is a new
> doubt. No open question is answerable from the issue comments; the owner has
> answered none of OQ1–OQ29 yet, so nothing moves out of **Open questions**.
>
> 1. **D2's "the judge … never throws" is false.** `defaultJudge`
>    (`helpfulnessEval.ts:204`) calls
>    `inferenceService.createToolFreeCompletion` with **no** error handling, and
>    `inferenceService` **rethrows** every connector failure
>    (`inferenceService.ts:36-48`). A Groq 429/timeout therefore propagates out of
>    `runHelpfulnessEval`, aborting the whole stage-3 run. The D2 sentence is
>    corrected; the abort-vs-record policy is the new **OQ30**, and the task
>    default (T14b) is to record, not abort.
> 2. **Fixture cleanup is not exception-safe.** `runHelpfulnessEval`
>    (`:237-274`) and `runRetrievalEval` (`:174-194`) call `clear()` at the *end*
>    of the loop, not in a `finally`. The same thrown provider error therefore
>    leaks seeded rows under the shared `evalUserId`, which then pollutes the
>    next run **and** the tool-use suite (OQ28). New **T14e** wraps both loops in
>    `try/finally { clear() }`.
> 3. **The LangSmith corpus push is append-only.** `pushMemoryCorpusToLangSmith`
>    (`memoryEvalService.ts:216`) calls `createExample` per case on every run, so
>    T9's mandated double-run (and any re-run) **duplicates every example** on
>    `tova-memory-evals`; and unlike `pushToLangSmith` it links **no run or
>    feedback**, so the dataset carries the corpus but no scores. New **OQ31**.
> 4. **T13 depended on ratification.** T13 said "with the ratified T10 bars in
>    hand", but ratification is owner-gated on OQ1/OQ4/OQ5. T13 is now split:
>    **T13a** produces the recommendation from the *proposed* T10 bars with the
>    "judge unvalidated" caveat and needs no owner input; **T13b** is the owner's
>    ratification + flag flip. No task now waits on an open question.
> 5. **Judge rate-limit doubt (new OQ32).** Stage 3 makes ~2 judge calls per
>    judged scenario on `gpt-oss-120b`; a 120b Groq tier may be tighter than the
>    20b gate's 30 RPM, and (per defect 1) a 429 aborts the run. T15c paced the
>    **gate** only; whether the judge needs the same is OQ32, and T15d now paces
>    stage 3 unconditionally.
>
> New open questions (OQ30–OQ32) are queued on #289.
>
> **Revision note (2026-10-14, plan-review pass 5).** This pass re-read the
> shipped stage-3, scheduler and gate code against the plan's own claims and
> found four material defects, plus one ticket-fixed input the plan had
> mislabelled as open. No owner question is answered by the issue comments, so
> nothing moves out of **Open questions**.
>
> 1. **The responder is *not* coupled to `TOVA_EVAL_*`.** D3, the harness facts,
>    OQ29 and one assumption all claimed `defaultRespond` inherits the tool-use
>    suite's `TOVA_EVAL_MODELS`/`TOVA_EVAL_MODEL`/`TOVA_EVAL_PROVIDER`. **False:**
>    `helpfulnessEval.ts:189` calls `resolveScheduledModels({})` with an *empty
>    argument*, and `resolveScheduledModels` (`evalRunService.ts:408`) reads those
>    keys from its **argument**, never from `process.env`. The responder is pinned
>    to the code constant `defaultEvalRef()` (`zai-org/GLM-5.3-Flash` on
>    DeepInfra, from `ROSTER_SEED`). The coupling is to a source constant, not to
>    env; corrected in all four places.
> 2. **The gate has a second silent-failure path: the timeout.** `enrichmentVotes`
>    wraps `classifyFileIntent` in `classifyWithinTimeout`
>    (`enrichmentService.ts:192`), which resolves `{files:false,workspace:false}`
>    on the `ENRICHMENT_TIMEOUT_MS` cap (default 1500ms, `:118`). A slow-but-correct
>    aux call is therefore scored a gate "no", inflating false negatives — the same
>    failure OQ11 names for a 429, via a different mechanism that the OQ11 fix
>    (a strict `classifyFileIntent` seam) does not by itself close. T15b now names
>    the timeout explicitly; whether the eval should bypass the production timeout
>    is the new **OQ33**.
> 3. **D14 contradicts D19.** D14 says kind-scope `findRunning` (the lease) so a
>    memory run does not block tool-use; D19 says the two suites must **never** run
>    concurrently because they share `evalUserId`. A kind-scoped lease *permits*
>    exactly the concurrency D19 forbids: a manual memory run can overlap a
>    scheduled tool-use run and clobber its fixtures. Fixed — `findRunning` stays
>    **global** (one live run of any kind); only `hasRunForUtcDay` and
>    `reclaimStaleEvalRuns` become kind-aware. The residual policy is the new
>    **OQ35**.
> 4. **T6/T8 would schedule the gate by accident.** `runMemoryEvals` always runs
>    gate + retrieval (`memoryEvalService.ts:198`), so a scheduled
>    `startMemoryEvalRun` would make the 36 live aux gate calls unattended —
>    precisely what D13/OQ26 say must not happen. T6's `startMemoryEvalRun` now
>    takes a `stages` selector and T8 passes `['retrieval']`; the gate stays
>    manual. T6's `metrics` payload is therefore **partial** (retrieval-only) on the
>    scheduled path.
> 5. **The judge-validation minimum is ticket-fixed, not a rule of thumb.** The
>    ticket body fixes "~30–50 hand-labelled pairs"; D11 had listed the 30 under
>    the same "provisional rule-of-thumb (OQ5)" as the agent-chosen 20/5/30. Split:
>    the ticket-fixed Ns are decisions (D11), only the gate/retrieval/helpfulness
>    Ns remain OQ5.
>
> New open questions (OQ33–OQ35) are queued on #289.
>
> **Revision note (2026-10-14, plan-review pass 6).** This pass read the shipped
> corpus (`corpus.ts`) against the plan's own T1b/OQ12/OQ19 claims and found one
> material corpus-validity defect and two premise errors. No owner question is
> answered by the issue comments, so nothing moves out of **Open questions**;
> one new question (OQ36) is queued.
>
> 1. **T1b would introduce a contradictory label pair (new, OQ36).** T1b
>    unconditionally adds bare-deictic fresh-ask negatives including "and that
>    one?", but `gate-and-that-one` ("And that one as well?") is an existing
>    **positive** with **no history** — the same input shape with the opposite
>    label. The corpus's unique-prompt invariant does not catch this (the strings
>    differ), so T1b as written would ship a silent contradiction. T1b is split:
>    **T1b-i** records the subtype on every positive (unconditional, no
>    collision); the bare-deictic negative hardening is **not a task** until
>    OQ36 settles what distinguishes a bare-deictic refer-back from a
>    bare-deictic fresh ask. The contradiction is exactly the ambiguity OQ12
>    flags, applied to the whole subtype.
> 2. **OQ12's two-case framing is too narrow.** Five positives are bare-deictic
>    with no history (`gate-same-as-before`, `gate-other-one`,
>    `gate-and-that-one`, `gate-previous-version`, `gate-one-from-yesterday`),
>    not the two the gate missed. If bare deixis is judged unfair, all five are
>    affected — a per-subtype bar cannot be set from the two misses alone. OQ12
>    is reworded to the subtype, not the misses.
> 3. **OQ19's premise is half-wrong.** The plan says the negatives "many are easy
>    fresh asks"; six are already memory-shaped fresh asks
>    (`gate-fresh-job-advice`, `gate-fresh-dinner`, `gate-fresh-trip`,
>    `gate-fresh-exercise`, `gate-fresh-bakery-names`, `gate-fresh-recipe` —
>    `corpus.ts:222` labels them so). T1b's "adversarial negatives not built" is
>    therefore false as stated; the open part is only whether *bare-deictic*
>    negatives are needed (tied to OQ36).
>
> **Revision note (2026-10-14, critic pass 7).** This pass read the shipped code and
> the two docs against each other and found one doc-drift regression, one
> completeness gap, and two new doubts. No owner question is answered by the issue
> comments, so nothing moves out of **Open questions**; two new questions (OQ37,
> OQ38) are queued.
>
> 1. **The repo doc's gate baseline is stale again (regression of the pass-3
>    "numeric drift fixed" claim).** T1b-i landed *after* pass 3 and annotated
>    every positive with a subtype, changing the corpus hash (D15); its own
>    observed run reads recall 88.9% / two misses, while
>    `docs/plan-289-gate-evals.md` still records the pre-annotation 83.3% / three
>    misses. T0's "there is no numeric reconciliation left" is therefore false
>    now. T0 is updated to reconcile the gate baseline (or mark it pre-T1b-i and
>    defer the re-capture to T9), and the repo doc gains a provenance caveat this
>    pass.
> 2. **The LangSmith corpus export dropped the new `subtype` (completeness gap,
>    fixed this pass).** `pushMemoryCorpusToLangSmith` wrote only `{refersBack}`
>    for a gate example, so the shareable dataset could not be stratified by the
>    refer-back subtype T1b-i introduced — the same split the local
>    `recallBySubtype` reports. The export now carries `subtype`, with a test.
> 3. **A cross-suite test-parallelism hazard (new, OQ37).** D19/T8 sequence the
>    two suites at *runtime*, but Jest runs `evals/mongoSource.test.ts` (tool-use)
>    and `evals/memory/memorySource.test.ts`/`helpfulnessEval.integration.test.ts`
>    concurrently in separate workers against one in-memory Mongo and the one
>    shared `evalUserId`. `mongoSource.test.ts` asserts a *global*
>    `Asset.countDocuments() === 4`, so a concurrent memory seed/clear can make it
>    flaky (not reproduced in 20 forced runs, but the shared mutable state is
>    real). The fix is OQ28's per-suite user (or serialising the two files); D19
>    covers the scheduler, not the test run.
> 4. **`parseJudgeVerdict`'s last-token rule can invert a reasoned verdict (new,
>    OQ38).** The parser takes the *last* standalone `A|B|TIE`, so a reply like
>    "A is better because B misses the point" parses as `B`. Distinct from OQ20
>    (failure vs tie) and OQ21 (truncation): the token is present and parseable,
>    just selected from the wrong position. Whether to prefer a final-line-only
>    token (or the first token) is a parser-policy call, not a code task yet.
>
> **Revision note (2026-10-14, plan-review pass 8).** This pass reconciled the
> plan's descriptive bodies with the code that has actually landed since they
> were written, moved one answered question out of **Open questions**, corrected
> one impossible task detail, and queued two genuinely new doubts. No owner
> question is answered by the issue comments beyond the one below, so nothing
> else moves.
>
> 1. **The `Current state`, `Decisions` and `Assumptions` bodies described
>    pre-T14 code.** T14a (`normaliseFact`), T14b (judge `error`), T14c
>    (responder config), T14d (preflight, `JUDGE_MAX_TOKENS = 512`) and T15d
>    (`pace`) all landed, but those sections still said the judge had `max_tokens:
>    16`, folded an unparseable reply to `tie`, had **no** `error` outcome, read
>    only `judgeModel`/`judgeProvider`, and that `containsFact` lower-cased only.
>    Every such sentence is corrected below. This was the pass-3 "numeric drift"
>    defect one level up — the *prose* had drifted, not just the numbers.
> 2. **OQ21 is answered and moves out of Open questions.** The T14d preflight
>    confirmed it live (a 16-token budget returned an empty completion; `256`
>    returned `A`), the budget is now `JUDGE_MAX_TOKENS = 512`, and the preflight
>    asserts a **parseable** verdict in both orders on every run. The residual
>    "assert on every model change" is exactly what T14d does, so OQ21 is a
>    decision (D2/D11), not an open question.
> 3. **T6's `models: ['memory']` is impossible through `beginEvalRun`.**
>    `beginEvalRun` (`evalRunService.ts:327`) maps `StartEvalRunOptions.models`
>    (`{provider, model}[]`) to `${provider}:${model}` keys, so a raw
>    `['memory']` string list neither type-checks nor lands as intended. T6 now
>    states the two viable shapes (a sentinel `{provider:'memory', model:'memory'}`
>    → `['memory:memory']`, or a separate `beginMemoryEvalRun` that writes
>    `models: ['memory']` directly) and picks the sentinel for the shared path.
> 4. **New OQ39 — gate-eval history fidelity.** The live chat path caps the
>    history handed to `enrichmentVotes` at **10 persisted messages**
>    (`chat.ts:827` `.limit(10)`), while `runGateEval` passes each case's
>    `history` **verbatim** (`memoryEvalService.ts:184`). A continuation whose
>    referent sits more than ~9 messages back would fire in the eval but not
>    live. Today's cases have short histories, so it does not bite; the fidelity
>    policy is open.
> 5. **New OQ40 — the precision bar is measured at the corpus's prevalence, not
>    the live base rate.** The gate set is 18 pos / 18 neg (a 50% positive rate by
>    construction). Precision depends on prevalence, so a ~70–80% precision bar
>    measured at 50% is not the precision the flag would show live (where the
>    positive rate is far lower). Should the go/no-go use a prevalence-adjusted
>    precision estimate (e.g. reweight by T11's observed dev vote rate), or is the
>    50/50 number the intended bar?
> 6. **OQ14 is expanded.** The shipped `judged` set is "cases with a non-empty
>    block", which **excludes every by-construction miss** — all five paraphrase
>    cases, both deleted-seed cases and both out-of-pool cases. So the stage-3
>    win-rate is measured only where retrieval already fires, and the RAG-headroom
>    cases contribute nothing to helpfulness. OQ14 now records this implication
>    alongside the all-vs-`expectSurfaced` choice.
>
> New open questions (OQ39–OQ40) are queued on #289.
>
> **Revision note (2026-10-14, critic pass 8).** This pass re-ran `npm run ci`
> (green, 1291 tests) and re-grounded the branch against the *current*
> `origin/main`, which the earlier passes did not: **#293 has since merged**
> (`origin/main` = `80492cd`, PR #302), and this branch does not contain it.
>
> 1. **The branch is stale relative to #293, and the auto-merge is semantically
>    broken (new, OQ41).** #293 replaced the bounded-pool overlap score with
>    whole-corpus BM25 and flipped `out-of-pool` to `expectSurfaced: true` on
>    `main`. A dry-run merge (`git merge-tree --write-tree origin/main HEAD`)
>    reports **no textual conflict**, but the merged tree keeps `main`'s
>    `out-of-pool: true` next to this branch's `corpus.test.ts` invariant that
>    requires every `out-of-pool` case to be `false` — so the merged tree's test
>    **fails**, and the recorded pre-#293 retrieval baseline (and the
>    "`out-of-pool` is a miss by design" framing) no longer describes the code
>    that will run. T9 cannot capture a valid baseline until the branch is
>    rebased and the corpus re-based. Recorded as OQ41.
> 2. **Hardening this pass (in-branch, no behaviour change).** Added the missing
>    `MEMORY_EVAL_GATE_PACE_MS` key to the config-test env-reset list and pinned
>    `gatePaceMs` default/parse/fallback (the getter was untested and an env leak
>    could silently set the gate pace to 0 — the OQ32 RPM risk); added a
>    `gateMetrics` test that a *failed* positive carries its subtype without
>    entering the subtype partition (T15b × T1b-i); added a `runHelpfulnessEval`
>    seed-throws case to the T14e cleanup tests.
>
> OQ41 is queued on #289.

## Motivation

`WORKSPACE_MEMORY_ENABLED` ships default-off (`config.workspaceMemory.enabled`,
`apps/server/src/config/index.ts:107`) because a wrong injection pollutes every
turn; the flag cannot go live until the gate is *measured*, not intuited. PR
#301 built the measurement scaffolding; PR #303 (this branch) added the stage-3
runner. What is still missing is the part that turns measurements into a
decision:

1. The gate set was `n=8`; it is now `n=36`, but precision still rests on
   negatives that may be too easy (OQ19) and on labels whose independence is
   unproven (OQ1).
2. Stage 3 runs, but the judge is **wired, not trusted**: no validation harness
   and no hand-labelled pairs exist yet.
3. Memory metrics (`precision`/`recall@k`/`win-rate`) do not fit
   `EvalRunRecord.results` (`pass|partial|fail|error`), so they are not
   persisted and not on the scheduled suite — the AC "added to the scheduled
   suite" is open.
4. Thresholds, the assistant-turns question, and the live go/no-go are all still
   open.

The ticket fixes the measurement approach (owner, 2026-10-13): deterministic
first, judge only where a substring cannot reach — a hand-labelled gate set, an
ID-matched retrieval corpus with RAG headroom (paraphrase, out-of-pool,
task/file slices), and a **pairwise, blinded, position-swapped** judge
(`openai/gpt-oss-120b` on Groq) for the holistic helpfulness delta. The
counterfactual (same prompt, block blanked) is required, because a model can
answer correctly without the injection and a judge-only setup would never catch
it. Precision is base-rate blind — `gateMetrics` returns `null` (not `1.0`) when
the gate never fires (`memoryEvalService.ts:65`), but a gate that fires almost
never still hides its recall failure behind a high precision — so every bar needs
a companion floor (recall/fire-rate, recall@k, pairwise win-rate) and a stated
minimum N.

## Current state (verified in-repo this pass)

### Delivered on this branch

- **Corpus + deterministic runner** (PR #301, `5a9ecfa`; grown on this branch):
  `apps/server/src/evals/memory/` — `types.ts` (`SeedKind`, `ScenarioCategory`,
  `MemorySeed`, `MemoryScenario`, `GateCase`), `corpus.ts`
  (`GATE_CASES` n=36, `MEMORY_SCENARIOS` n=22), `memorySource.ts`
  (`seedMemoryScenario`, `clearMemoryCorpus`, `SeedIdMap`; materialises real
  `Session`/`Message`/`Asset`/`Task`/`TaskEvent` rows under `evalUserId`),
  `memoryEvalService.ts` (`gateMetrics`, `retrievalMetrics`, `runGateEval`,
  `runRetrievalEval`, `runMemoryEvals`, `pushMemoryCorpusToLangSmith`).
- **Stage-3 runner** (this branch): `helpfulnessEval.ts`. Its shape **after the
  T14 hardening that landed** (the pre-T14 shape is recorded in the pass-4–5
  notes; the descriptive bodies are corrected here):
  - `runHelpfulnessEval(deps)` returns `{ results, metrics }`;
    `HelpfulnessDeps = { scenarios?, seed?, clear?, retrieve?, respond?, judge?,
    pace? }`. Both the per-scenario body and the trailing cleanup are wrapped in
    `try { … } finally { await clear(); }` (T14e), so a thrown provider error
    cannot leak seeded rows under the shared `evalUserId`.
  - `respond(query, block)` takes the **block string** (not the assembled
    prompt); the default uses `buildSystemContent(null, null, true, null, block)`
    — the production envelope, but with a **null user and no file-library block**
    (see OQ23) — `temperature: config.memoryEval.responderTemperature` (default
    `0`), `max_tokens: 512`, tag `memory-eval:helpfulness:respond`. The model is
    `config.memoryEval.responderModel`/`responderProvider` when set (T14c), else
    the roster fallback `resolveScheduledModels({})` (→ `ROSTER_SEED`
    `zai-org/GLM-5.3-Flash`).
  - `judge(query, answerA, answerB)` returns `'A' | 'B' | 'tie' | 'error'`; the
    default calls `config.memoryEval.judgeProvider`/`judgeModel` with
    `temperature: 0`, **`max_tokens: JUDGE_MAX_TOKENS = 512`** (raised from 16 by
    T14d; see OQ21, now a decision), tag `memory-eval:helpfulness:judge`.
  - `buildJudgePrompt` is blinded; `parseJudgeVerdict` takes the last standalone
    `A|B|TIE` token and returns **`error` for an empty/unparseable reply**
    (T14b; OQ20/OQ38 cover the residual policy and the last-token selection).
  - `resolveSwappedOutcome(first, second)` → `'win' | 'loss' | 'tie' | 'error'`;
    only an order-consistent win is a win, a flip or a judge `tie` collapses to
    `tie`, and **either presentation erroring makes the pair `error`** (T14b).
    A thrown judge call is caught per pair into `error` (record-and-continue, the
    OQ30 default) rather than aborting the run.
  - `containsFact` routes **both** sides through `normaliseFact`
    (casefold + collapse internal whitespace + trim, T14a); the pre-T14
    lower-case-only form is gone. The residual masking doubt is OQ22.
  - `helpfulnessMetrics`: `winRate = (wins + 0.5 × ties) / judged`; `errors` is a
    **separate count excluded from the denominator** (T14b); `judged` counts
    cases with a non-empty block (so a by-construction miss with an empty block
    is skipped, but a `expectSurfaced:false` case that happened to surface would
    still be judged — see OQ14).
  - `runJudgePreflight(judge)` (T14d) issues one call in both orders and
    **throws** unless both verdicts are parseable.
  - `defaultPace` (T15d) reads `config.memoryEval.paceMs` (default 1000ms) and is
    awaited before every live responder/judge call; tests inject a no-op.
- **Judge-validation harness** (this branch, T5):
  `apps/server/src/evals/memory/judgeValidation.ts` — `JudgeLabel`/
  `JudgeAgreement` types, `constructedJudgeLabels()` (derived from the corpus,
  arms alternate so a constant-`A` judge cannot pass), `handJudgeLabels` (a
  checked-in `agent-authored` seed covering all three classes), and
  `judgeAgreement(labels, judgeFn)` returning `{ n, errors, accuracy, kappa,
  confusion }` (Cohen's kappa over `A`/`B`/`tie`, null when a class is absent;
  `error` verdicts excluded from the denominator, OQ20). `defaultJudge` is now
  exported so the CLI can reuse the live judge. The constructed set is
  a smoke test (callable + not position-biased), **not evidence**; the hand seed
  is the non-circular number and is owner-gated on OQ1.
- **Config**: `config.memoryEval` (`apps/server/src/config/index.ts:148`) now
  exposes `judgeModel`/`judgeProvider` (defaults `openai/gpt-oss-120b`/`groq`),
  `responderModel`/`responderProvider` (undefined → roster fallback, T14c),
  `responderTemperature` (default `0`), `paceMs` (default `1000`, T15d),
  `gatePaceMs` (default `2000`, T15c) and `judgePaceMs` (default `2000`, T5).
  `config.aux.model` remains the gate model (`openai/gpt-oss-20b`).
- **CLI**: `scripts/run-memory-evals.ts` runs the deterministic stages by
  default, stage 3 only with `--helpfulness` (manual-only), the judge
  preflight with `--preflight-judge` (T14d), and judge validation with
  `--validate-judge` (T5). There is **no `--all`** flag — and
  none is needed, because `--helpfulness` already prints all three stages. Pushes
  the corpus to `tova-memory-evals` when `LANGSMITH_API_KEY` is present (append
  on every call; OQ31).
- **Tests**: `corpus.test.ts` (unique ids/prompts, label counts, history
  presence, note-provenance, `expectSurfaced`↔category, fact-not-in-query,
  every-paraphrase no-overlap, per-category minimum-N, expected-fact-in-seed,
  filler-only-in-out-of-pool), `memoryEvalService.test.ts`,
  `memorySource.test.ts`, `helpfulnessEval.test.ts` (pure swap/parse/prompt/
  metric + runner with fakes), `helpfulnessEval.integration.test.ts` (real Mongo
  fixtures, faked provider; a first-answer judge must collapse to a tie),
  `judgeValidation.test.ts` (constructed-pair construction, known-value Cohen's
  kappa, constant-`A` position bias, error exclusion, absent-class null,
  hand-seed shape).
- **Repo doc**: `docs/plan-289-gate-evals.md` on this branch records the n=36/n=22
  baseline and a stage-3 section. Two drifts were open: the **textual** one —
  Decision 1 still said "The judge is not wired in this increment", contradicting
  the Stage 3 section — and a **numeric** one that the pass-3 note wrongly called
  fixed: T1b-i (landed after pass 3) annotated every positive with a subtype,
  changing the corpus hash and shifting the observed gate run (83.3% → 88.9%), so
  the recorded baseline is pre-annotation. This pass fixed the sentence and the
  stale OQ12 framing and added a provenance caveat; **T0 now also owns the
  baseline reconciliation** (re-capture or explicitly defer to T9), since T9
  re-captures on the annotated corpus anyway.

### Not built (the work this plan is for)

- Gate refer-back **subtypes are built** (T1b-i): `GateSubtype` on `GateCase`,
  every positive annotated, `recallBySubtype` reported. Only *bare-deictic*
  negative hardening remains, and it is not a task until OQ36 settles the
  subtype's label (pass-6).
- Judge-validation harness and hand-labelled pairs (T5) — **built this pass**
  (`judgeValidation.ts` + `--validate-judge`); the checked-in hand seed is
  `agent-authored` and the "judge trusted" line stays owner-gated on OQ1.
- Metrics persistence: no `kind`, no `metrics`, no migration (T6).
- Admin rendering of memory metrics (T7).
- Kind-aware scheduler / lease (T8).
- Responder generation-budget guard (`max_tokens: 512`, no truncation flag)
  (T14f) — needs `finish_reason` plumbed through `NeutralCompletion`
  (`llmTypes.ts:100`, which has `choices`/`toolResults`/`usage` but **no
  `finish_reason`**), so T14f is a connector-shape change, not a local guard.
- A `stages` selector on `runMemoryEvals`/`startMemoryEvalRun` (T6) so scheduling
  cannot run the live gate (pass-5 defect 4).

### Harness facts (unchanged, still true)

- **Gate**: `enrichmentVotes` → `classifyFileIntent`
  (`apps/server/src/services/enrichmentService.ts:134`), a single tool-free aux
  call at `temperature: 0`, `max_tokens: 512`, with the aux model
  `config.aux.model` (default `openai/gpt-oss-20b` on `groq`,
  `config/index.ts:122`). **`enrichmentVotes` returns
  `{files:false,workspace:false}` whenever `ENRICHMENT_ENABLED` is not truthy**
  (`enrichmentService.ts:221`; the flag defaults **on**, `:31`), so a gate run
  with enrichment off scores recall 0 across the board. **Failure is silent**:
  `classifyFileIntent` catches every error (including a Groq 429) into both-false
  (`enrichmentService.ts:159`), so the runner cannot today tell a failed call
  from a negative vote (OQ11, D7).
- **Retrieval**: `apps/server/src/services/workspaceRetrievalService.ts` —
  `collectWorkspaceSlices(userId, excludeMessageId?, excludeAssetId?)`;
  `retrieveWorkspaceSlices(prompt,userId,n=MAX_SLICES,...)` returns picked slices
  **with ids**; `retrieveWorkspaceBlock` returns only the rendered string (which
  carries **no ids**); `buildWorkspaceBlock(prompt, slices)` is the string
  builder. Bounds: `MESSAGE_POOL=200`, `ASSET_POOL=50`, `TASK_POOL=50`,
  `MAX_SLICES=6`, `BLOCK_CAP=1200`, `matchSnippet` cap 160. Only `role: 'user'`
  messages are indexed. Sessions filtered `deletedAt: null`. Assets filtered
  `ephemeral != true` and require extracted text. Task text is the
  `user`/`assistant` `TaskEvent` stream in `seq` order. **Neither the eval nor
  the runner checks `config.workspaceMemory.enabled`** — the eval reads the
  services directly, so `WORKSPACE_MEMORY_ENABLED` is irrelevant to stages 1–3
  (it matters only to the live chat path, and therefore only to T11).
- **Harness**: `apps/server/src/models/EvalRunRecord.ts` — schema
  `{startedAt, finishedAt, status:'running'|'done'|'error', error, models[],
  results:[{caseId, model (required), provider (required), score, report}]}`,
  collection `evalruns`, indexes `{startedAt:-1}` and `{status:1,startedAt:-1}`;
  migration `apps/migrations/src/20261007000000-create-eval-runs.ts`. There is
  **no `kind` and no `metrics` field** today. Mongoose is strict by default, so
  `metrics` needs an explicit sub-schema, not "schemaless" tolerance.
  `evalRunService.ts` — `beginEvalRun` (lease via
  `findRunning = EvalRunRecord.findOne({status:'running'})`, module-private
  `EvalRunDeps`), `executeEvalRun`, `startEvalRun`, `resolveScheduledModels`,
  `EvalScore = 'pass'|'partial'|'fail'|'error'`; `runEvalSuite` writes `results`
  with `model`/`provider`. `evalScheduler.ts` — `hasRunForUtcDay(now)` and
  `reclaimStaleEvalRuns(maxAgeMs)` are **not** kind-aware;
  `startEvalScheduler(run, opts)` calls one `run` callback per tick after a
  single `hasRun` gate. Wired in `apps/server/src/index.ts:172`.
  `routes/adminEvals.ts` + `evalRunsAdminService.ts` + `AdminEvalsView.tsx`;
  shared `AdminEval*` contracts at `apps/shared/src/contracts.ts:314` (no
  `kind`/`metrics`). `evalRunsAdminService.countScores` (`:30`) counts **every**
  `results` row by `score` with no `kind` filter, so a memory run's sentinel
  rows will land in the summary counts unless that is deliberately accepted or
  changed (OQ27). Manual "Run now" calls `beginEvalRun` + `executeEvalRun`.
- **Shared eval user (new this pass).** The tool-use suite (`evals/mongoSource.ts`)
  and the memory suite (`evals/memory/memorySource.ts`) both key on the one
  reserved `evalUserId` (`6f61e78155a5b2c0d3e1f7a2`). `clearMemoryCorpus` deletes
  **all** `Session`/`Message`/`Asset`/`Task` for that user; `clearEvalSource`
  deletes **all** `Asset` and the `User`. The two teardowns are mutually
  destructive, so the suites cannot overlap (OQ28, T8).
- **Stage-3 responder is pinned to a code constant, *not* to env.** `defaultRespond`
  calls `resolveScheduledModels({})` with an **empty argument**;
  `resolveScheduledModels` (`evalRunService.ts:408`) reads
  `TOVA_EVAL_MODELS`/`TOVA_EVAL_MODEL`/`TOVA_EVAL_PROVIDER` from its **argument**,
  never from `process.env`. So the responder defaults to the constant
  `defaultEvalRef()` (`zai-org/GLM-5.3-Flash` on DeepInfra, from `ROSTER_SEED`)
  and is **not** moved by a tool-use eval-model change. T14c added
  `config.memoryEval.responder*` as an explicit override, so a sweep is a config
  change; the residual risk is that a `ROSTER_SEED` edit moves the arm when the
  override is unset, and the identity is not yet recorded in the run (OQ29).
- **No ad-hoc `process.env` at call sites** (#142): any new model id goes through
  `config`.
- **Baseline** (local stack, this branch). Retrieval is stable at
  `expectedMet 77.3% / surfacedRate 59.1%` (n=22); the gate has **run-to-run
  variance**: the pre-T1b-i read was precision 100% / recall 83.3% / fireRate
  41.7% (n=36, three misses), and the post-T1b-i annotated read was precision
  100% / recall 88.9% / fireRate 44.4% (n=36, two misses: `gate-one-from-yesterday`
  bare-deixis, `gate-finish-draft` continuation; `gate-other-one` passed that run
  where it had missed before). Stage 3 has not been run end-to-end yet. The
  retrieval misses are by design (`paraphrase` 0/5, `deleted-seed` 0/2,
  `out-of-pool` 0/2). **The gate variance is itself a finding** — it is why T9
  runs twice and why OQ26 asks whether a double-run disagreement blocks
  ratification.

## Decisions

These are the choices this plan commits to. Each is small and reversible.
Genuine unknowns the owner must settle are in **Open questions**, and no task
below depends on one being answered (where a task produces input to a decision,
that is stated; the dependency order of the tasks themselves is in **Task
dependency order**).

1. **Three stages, deterministic backbone, judge only for the holistic delta.**
   Stage 1 gate and stage 2 retrieval stay non-judged. Stage 3 adds a
   deterministic backbone plus a pairwise judge for the part a substring cannot
   express. *Caveat (honesty):* "deterministic" is exact for stage 2 (a Mongo
   read) but a **loose label for stage 1**, which is an LLM aux call at
   `temperature: 0`. Providers are not byte-stable, so stage 1 is
   "non-judged", not "deterministic" in the formal sense (OQ26).

2. **The judge is `openai/gpt-oss-120b` on Groq, through the existing
   connector.** `inferenceService.createToolFreeCompletion` with
   `provider: 'groq'`. Pairwise A/B on the same prompt with vs without the
   injected block; the judge is **not told which arm is which** (blinded); each
   pair is judged in **both orders** (position swap). It must never be the gate
   model (`gpt-oss-20b`) — self-preference. The model id/provider are
   config-sourced (`config.memoryEval.judgeModel`/`judgeProvider`, defaults
   `openai/gpt-oss-120b`/`groq`), never ad-hoc `process.env` (#142). **The judge
   call can throw** (`defaultJudge` has no error handling and `inferenceService`
   rethrows); since T14b a thrown call is caught **per pair** into an `error`
   outcome so one dead call does not abort the run (the OQ30 record-and-continue
   default). An unparseable reply is now also an `error`, not a `tie` (T14b); the
   residual *denominator* policy is OQ20 and the last-token selection is OQ38.
   The token budget is `JUDGE_MAX_TOKENS = 512` (T14d, after the 16-token default
   truncated the reasoning model to an empty completion — OQ21, now closed).

3. **Stage-3 responder: one roster model, at `temperature: 0`.** The with/without
   arms must be answered by the *same* model for comparability and cost. The
   implementation uses the eval suite's roster default
   (`resolveScheduledModels({})` → `zai-org/GLM-5.3-Flash` on DeepInfra) and
   `temperature: 0`. T14c landed the config override
   (`config.memoryEval.responderModel`/`responderProvider`/`responderTemperature`),
   so the model is now a config choice, not a source edit; the default is an
   engineering choice, not a ratified number (OQ24 on model coverage, OQ13 on
   repeats). *Caveat (honesty):* the responder is **not** the tool-use env knobs —
   `defaultRespond` passes `{}`, so with no override the id is the hard-coded
   `ROSTER_SEED` fallback; a `ROSTER_SEED` edit moves the arm, and the identity is
   unrecorded until T6 (OQ29).

4. **The stage-3 deterministic backbone is `expectedFact` containment.** The
   with-arm answer must contain `expectedFact`; the counterfactual is the same
   prompt with `block: ''`; the injected slices are read via
   `retrieveWorkspaceSlices` (ids) and the expected id is asserted against
   `idMap[scenario.expectedSliceId]`. The rendered block carries no ids, so the
   id assertion must never read it. T14a landed `normaliseFact`
   (casefold + whitespace-collapse), and **both** the block and the answer checks
   route through it, so a fact split by a newline/double space no longer false
   misses. The residual — whether normalisation can mask a genuinely absent fact —
   is OQ22. The judge is the backstop for the residual paraphrase risk.

5. **The stage-3 helpfulness bar is the pairwise judge win-rate.** The floor
   value is proposed in T10 and ratified by the owner (OQ4). Ties and errors are
   their own counts (D10); T14b gave `helpfulnessMetrics` an `errors` count
   separate from `ties`, excluded from the win-rate denominator. The shipped
   `winRate` still scores a tie as 0.5 — whether a tie should be 0 or 0.5 is OQ3.

6. **The judge returns raw per-order verdicts; the scoring policy lives in
   aggregation.** `runHelpfulnessEval` calls the judge twice (arguments swapped)
   and stores both raw picks (`verdicts`); `resolveSwappedOutcome` maps them to
   `win | loss | tie | error`. Whether an order-disagreement is a `tie` or a loss,
   and whether a tie scores 0 or 0.5, is a one-line change in that pure function
   (OQ3) that no code task bakes in.

7. **Provider failures in the gate stage are recorded distinctly from a negative
   vote, and the gate call is paced.** `runGateEval` should record per-case
   `{observed, failed}` (a distinct `error` outcome) and pace/retry to stay under
   the provider RPM; the runner must not silently map a 429 to a gate "no". **Not
   implemented yet** (T15b/T15c). The denominator policy (exclude errors vs count
   them) is an aggregation choice (OQ11), so the runner and the scheduler do not
   depend on the answer.

8. **Stage 3 is recorded per category, so its denominator is a reporting
   choice.** `runHelpfulnessEval` writes a per-scenario row (category, both arms'
   `containsFact`, id assertion, raw judge picks). Whether the reported win-rate
   is over all scenarios or only `expectSurfaced: true` scenarios is OQ14; the
   runner can compute either from the same rows.

9. **Metrics persistence: extend `EvalRunRecord`, do not fork the harness.**
   Add `kind: 'tool-use' | 'memory'` (default `'tool-use'`) and an optional
   typed `metrics` sub-schema. Memory per-case rows reuse the existing `results`
   shape with sentinel `model: 'memory'`, `provider: 'memory'` (avoids touching
   the two `required` fields, so the tool-use contract is untouched) and
   `score: pass|partial|fail|error`. The continuous rollup
   (precision/recall/fire-rate, recall@k, win-rate, each `n`, plus error counts)
   lives in `metrics`. `AdminEval*` contracts gain optional `kind`/`metrics`;
   `AdminEvalsView` renders them. **`countScores` stays unchanged by default**
   (memory rows land in the same summary counts, disambiguated by the `kind`
   badge); OQ27 is a *confirmation* of that default, so T6/T7 do not wait on it —
   if the owner wants a kind-scoped summary that is a follow-up, not a re-plan.
   A sibling collection remains an option if the shapes diverge later, but that
   is a re-plan, not a default.

10. **Helpfulness is reported as a judge win-rate with explicit ties/errors.**
    Per scenario record: (a) with-block answer contains `expectedFact`
    (normalised), (b) `retrieveWorkspaceSlices` included the expected id, (c)
    without-block answer contains `expectedFact` (the counterfactual), (d) judge
    verdict mapped back from the swapped pair. Win-rate = wins / (wins + losses)
    over pairs with a decisive verdict; ties and errors are reported as their own
    counts. T14b landed the separate `errors` count and excluded errors from the
    denominator, so the only remaining tension is the **tie** weight: D10's text
    excludes ties from the denominator while the shipped `winRate` includes them
    at 0.5 (OQ3). The deterministic backbone (a)–(c) is reported separately
    from (d).

11. **Minimum N before any percentage is treated as evidence.**
    Two classes, so it is clear which are decisions and which are provisional:
    - **Ticket-fixed (not open):** judge validation = **~30–50** hand-labelled
      pairs before the judge is trusted at scale (ticket body). This is a
      decision, not OQ5.
    - **Provisional, agent-chosen (OQ5):** gate **≥ 30** labelled cases with both
      labels well represented (≥ 12 each); retrieval **≥ 20** scenarios with
      **≥ 5** in each hard category (`paraphrase`, `file`, `task`, plus the
      by-construction misses); helpfulness **≥ 30** judged pairs.
    The provisional Ns are a rule-of-thumb starting point (OQ5), not a derivation;
    T10 may revise them from observed variance.

12. **Provisional 50% is the measurement bar, not the ship gate.** Ship target
    to confirm from the baseline is gate precision **~70–80%** *with* a
    recall/fire-rate floor; retrieval as recall@k; helpfulness as pairwise
    win-rate. The ratified numbers come from the enlarged baseline (baseline
    first, then ratify).

13. **Scheduling shape: only the Mongo-only stage joins the daily suite by
    default; stages 1 and 3 stay manual until decided.** The scheduler runs
    **stage 2 (retrieval)** on the same `TOVA_EVAL_SCHEDULE` window as the
    tool-use suite, sequentially (D19). Stage 1 is a live aux call per case (36
    calls), so whether it belongs on the unattended path is **OQ26** — until
    answered, T8 does **not** schedule it, and T8 therefore has no dependency on
    an open question. Stage 3 (judge + responder) is manual-only (OQ6). Default
    schedule stays `off`. *Caveat (honesty):* even stage 2 writes fixtures to the
    shared live `evalUserId` on every tick; that is precedented by the tool-use
    suite but is called out in Assumptions and OQ28.

14. **Idempotency is kind-aware; the lease stays global.** `beginEvalRun`
    currently rejects whenever *any* run is `running`. The two concerns must be
    split (corrected pass 5):
    - **`hasRunForUtcDay` becomes kind-scoped** — a tool-use run today must not
      suppress the memory run (and vice versa), so the daily suite can run both.
    - **`reclaimStaleEvalRuns` becomes kind-scoped** (a stale row is reclaimed per
      kind; harmless either way once the lease is global).
    - **`findRunning` stays global** — one live run of *any* kind at a time. D19
      forbids the suites running concurrently (shared `evalUserId`), so
      kind-scoping the lease would *permit* the exact overlap that corrupts
      fixtures. The scheduler's sequential tick (T8) is the normal path; the
      global lease is the backstop for a manual "Run now" overlapping a tick.
      Whether to instead allow cross-kind concurrency with per-suite users is
      **OQ35** (tied to OQ28).
    Add `{kind:1, startedAt:-1}` to `evalruns` via a migration.

15. **The run records every model identity and a corpus hash.** `metrics`
    carries the resolved **gate** model/provider (`config.aux.*`), the **responder**
    model/provider (`config.memoryEval.responder*` when set, else the
    `resolveScheduledModels`/`ROSTER_SEED` fallback), the **judge** model/provider
    (`config.memoryEval.judge*`), and a hash of the corpus, so a baseline is
    reproducible and a change in any model or the corpus is visible rather than
    silent (OQ16 covers the re-ratification policy; the *recording* is
    unconditional so no task depends on that policy — OQ29). **Definition:** the
    corpus hash is a SHA-256 over the canonical JSON of `GATE_CASES` +
    `MEMORY_SCENARIOS` (stable key order). This is well-defined because the
    corpus is plain JSON — strings/booleans/numbers/arrays, no `Date`/`ObjectId`/
    functions (verified in `types.ts` this pass). T6 owns the helper and a test
    pinning that a one-character label edit changes the hash.

16. **The corpus stays synthetic; the out-of-pool case is a synthetic burial.**
    Owner-decided (issue comment, 2026-10-13): the checked-in cases are
    structural analogues with no real personal data; the real probe pattern
    (seed in a live chat, probe from a fresh/deleted chat) is the shape copied.
    The dump showed only ~47 live user messages (< `MESSAGE_POOL=200`), so the
    real recency bound does not bite there; the corpus carries `deleted-seed`
    and a synthetic `out-of-pool` burial separately.

17. **The with-arm is assembled through the production prompt builder.** The
    shipped `defaultRespond` calls `buildSystemContent(..., block)`, so the block
    rides the real envelope (T3 implemented this; the earlier OQ15 is therefore
    closed). It is **not** full production fidelity — a null user and no file
    library are passed, so the block does not compete with those sections as it
    would live (OQ23).

18. **T14/T15 harden the harness and land before T5 and T9.** The thing being
    validated (the judge) and measured (the baseline) must be the hardened one,
    so the task order is not the T-number order. See **Task dependency order**.

19. **The two eval suites run sequentially, never concurrently, under the shared
    `evalUserId`.** Because `clearMemoryCorpus` and `clearEvalSource` are mutually
    destructive (shared eval user), T8's tick runs tool-use to completion, then
    the memory stage, then returns; no `Promise.all`, no overlapping ticks (the
    existing `busy` flag already prevents stacking). This is the safe default and
    needs no owner input. The *alternative* — one reserved user per suite — is
    OQ28; if chosen it is a small follow-up, not a T8 blocker.

20. **The gate set records a refer-back subtype; the negative set is already
    partly adversarial and is not grown until OQ36 settles bare deixis.** Each
    positive gains `subtype: 'explicit' | 'continuation' | 'bare-deixis'`
    (**T1b-i**, unconditional — recording the subtype is safe and lets bars be
    set per subtype). The plan does **not** add bare-deictic fresh-ask negatives
    (the pass-4 D20 text proposed "and that one?"): the corpus already has six
    memory-shaped fresh-ask negatives (`gate-fresh-job-advice` … `gate-fresh-recipe`,
    `corpus.ts:222`), and a bare-deictic negative would collide with the existing
    bare-deictic *positive* `gate-and-that-one` ("And that one as well?") — the
    same input shape, opposite label (pass-6, OQ36). The subtype recording
    changes the corpus hash (D15), so T9's baseline is re-captured after T1b-i.

## Task dependency order

Dependencies are tasks, never open questions. Read this before the checklist.

```
T0 ──────────────────────────────────────────────┐  (docs; independent)
T1b-i subtype recording ─────────────┐            │
T14a normaliseFact ─┐                │            │
T14b judge error   ─┼─→ T5 judge-validation harness ─→ (hand labels: OQ1)
T14c responder cfg ─┤                              │
T14d judge preflight┘                              │
T14e cleanup-finally ─┐                            │
T14f responder budget ─┐                           │
T15a enrichment precond ─┐                         │
T15b gate failure distinct ┼─→ T9 enlarged baseline ─→ T10 thresholds ─→ T13a recommendation ─→ T13b owner ratify+flip
T15c gate pacing ────────┤   └─→ T12 assistant-turns
T15d stage-3 pacing ─────┘   └─→ T11 LangSmith sanity
T6 persist metrics ─→ T7 admin client
T6 ─→ T8 scheduler wiring (stage 2 only)
```

- **T1b-i** feeds T9 (it changes the corpus and therefore the hash); it needs no
  owner input (D20). Only the *judgement* on the bare-deixis labels (OQ12/OQ36)
  and whether bare-deictic negatives are added (OQ36) stays open. Adding those
  negatives is not a task, so no task depends on that answer.
- **T5** consumes T14b (the `error` outcome it validates) and T14d (preflight).
  Its harness is built and its constructed-set agreement reported without owner
  input; only *trusting* the judge at scale waits on the hand labels (OQ1), and
  that is a report line, not a blocker on T5 completing.
- **T9** consumes T1b-i (re-captured corpus), T14a (normalised fact check), T14e
  (exception-safe cleanup), T14f (non-truncating responder) and T15a–d (a clean
  gate + a non-aborting stage-3 run). It runs the CLI manually, so OQ26 does not
  touch it.
- **T10** consumes T9 and proposes **both** the deterministic and the stage-3
  bars. It does not depend on any open question: the deterministic bars come from
  the T9 numbers, and the stage-3 bar is proposed from the same numbers with an
  explicit "judge unvalidated" caveat. OQ1/OQ4/OQ5 are inputs to *ratification*,
  not to the proposal.
- **T13a** consumes T9–T12 and the T10 *proposal* (not its ratification), so it
  needs no owner input; **T13b** is the owner action that consumes OQ1/OQ4/OQ5.
- **T14e/T14f/T15d** are hardening tasks with safe-default behaviour, so
  OQ30/OQ32/OQ34 do not gate them.
- **T7** consumes T6; **T8** consumes T6 (the `{kind,startedAt}` index) and D19,
  not OQ28.
- T1/T2/T3/T4 are done.

## Assumptions, and where they could be wrong

Listed because the plan's credibility rests on them; each names the mitigation.
An assumption that survives no mitigation is in Open questions instead.

- **The gate is stable enough to compare a single vote to a label.** The aux call
  is `temperature: 0`, but providers are not guaranteed byte-stable across runs.
  If gate metrics drift between identical runs, thresholds over a single pass are
  unsafe. Mitigation: T1b-i keeps `n` above the bar; T9 runs the suite twice and
  records the run-to-run delta. **Residual doubt is real, not zero:** one delta
  between two runs does not establish stability across days; if the two runs
  disagree, that is itself a finding that blocks ratification (now OQ26).
- **Hand labels are independent evidence.** The corpus is agent-authored *and*
  the gate is agent-tuned; if the same agent writes both, the labels are not an
  independent check. This is the single largest methodological risk and is
  **OQ1**. T1/T2/T5 build the data regardless; T10 *proposes* a bar from the
  baseline either way, and only the *ratification* consumes independent labels —
  so T10 is not blocked, but the ratified stage-3 bar is owner-gated.
- **`gpt-oss-120b` is served by the Groq connector.** **Now verified live** (T14d
  ran `--preflight-judge` successfully: `first=A second=B`), so the model is
  callable through the connector. Family independence from the `gpt-oss-20b` gate
  remains **OQ2**; the preflight must be re-run on any judge model/provider change
  (T14d does exactly that).
- **The judge's token budget is enough for a reasoning model to emit a verdict.**
  **False as originally written, now fixed (was OQ21).** `gpt-oss-120b` is a
  reasoning model and a 16-token budget truncated it to an empty completion
  (measured live: `max=16 => ""`, `max=256 => "A"`). T14d raised the budget to
  `JUDGE_MAX_TOKENS = 512` and made the preflight assert a **parseable** verdict,
  so a future truncation fails loudly rather than silently scoring `error`. OQ21
  is closed as a decision.
- **The judge adds signal beyond the substring backbone.** On a synthetic
  personal-fact corpus the without-block arm almost always fails, so a pairwise
  win is near-guaranteed and the judge may merely re-express the substring
  check. The judge only earns its keep on scenarios where the without-arm is
  *plausible* (the fact is inferable from general knowledge, or the block is
  partly noisy/irrelevant). Whether the corpus needs such "plausible-without"
  cases is **OQ17**; if not, stage 3 is largely a determinism check and should be
  reported as such.
- **The constructed judge-validation set is circular.** It labels pairs by
  the same substring rule the backbone uses, so a judge can pass it by echoing
  the rule rather than judging holistic quality. The hand-labelled set (OQ1/OQ4)
  is therefore the only non-circular validation; the constructed set is an
  interim smoke test, not evidence. **Live T5 check (2026-10-14):** the judge
  *failed* to echo the rule (63.6% on the constructed set), so in practice it is
  not a pure echo — but that does not make it evidence; it just means the set
  measures judge/backbone divergence, not judge quality.
- **Substring containment is a fair helpfulness backbone.** The responder may
  paraphrase (`paediatrician` vs `pediatrician`, `twelve thousand` vs
  `£12,000`). T14a landed `normaliseFact` (casefold + whitespace-collapse) and
  routed **both** the block and the answer checks through it, so a fact split by a
  newline or double space no longer false misses. The residual fairness question
  is **OQ22** (OQ7 is closed — the backbone itself is ticket-decided).
- **Position-swap consistency is the right noise filter.** Requiring agreement
  collapses a weak judge to mostly `tie`, shrinking the decisive denominator.
  Ties/errors are reported separately (D10); whether the rule or its scoring is
  right is **OQ3**.
- **The judge's failure mode is distinguishable from its "tie" vote.** **Now
  true (T14b).** `parseJudgeVerdict` returns `error` for an empty/unparseable
  reply, `resolveSwappedOutcome` returns `error` if either presentation errored,
  and `helpfulnessMetrics.errors` is separate from `ties` and excluded from the
  win-rate denominator. The residual *denominator/reporting* policy is **OQ20**.
- **The judge is an injected seam that never throws.** **False, and now handled
  (T14b).** `defaultJudge` has no error handling and `inferenceService` rethrows,
  so a provider error would abort `runHelpfulnessEval`; T14b catches a thrown
  judge call per pair into an `error` (record-and-continue default). Whether to
  abort instead is **OQ30**.
- **A thrown error does not corrupt the next run.** **False, and now fixed
  (T14e).** The runners used to clear only after the loop, so a mid-run throw
  leaked seeded rows under the shared `evalUserId`. Both `runHelpfulnessEval` and
  `runRetrievalEval` now clear in `finally`; the leaked-rows interaction with the
  tool-use suite is **OQ28**.
- **The LangSmith corpus push is a stable artefact.** **False** (pass 4):
  `pushMemoryCorpusToLangSmith` appends on every call, so T9's double-run
  duplicates the dataset, and no run/feedback is linked. Whether to make it
  idempotent and score-linked is **OQ31**.
- **Minimum-N values are defensible.** 30/20/5/30 are chosen, not derived. They
  may be too small to separate a real delta from noise. **OQ5**; T10 may revise
  them from observed variance.
- **The stage-3 cost is acceptable.** Each scenario costs two responder calls +
  two judge calls; at ≥ 30 scenarios that is ≥ 120 live calls per full run, and
  judge validation adds more. Stage 3 is manual-only (D13) precisely because of
  this. If OQ6 flips to unattended, the cost must be re-estimated.
- **A helpfulness baseline is reproducible from the recorded run.** It is not,
  today: `metrics` records only the gate model and corpus hash, while the
  responder is the unrecorded `ROSTER_SEED` constant (corrected pass 5 — it is
  *not* env-coupled) and the judge reads `config.memoryEval`. T6/T9 now record
  all three identities (D15), so the assumption becomes checkable; the
  *invalidation* policy on a model change is **OQ29** (extends OQ16 from the gate
  to stage 3).
- **The memory suite can share the daily window with tool-use.** True only once
  the lease/idempotency are kind-aware (D14), the suites run **sequentially**
  (D19) and stage 3 is out of the unattended path (D13). All are tasks, not
  assumptions left to drift. Stage 1 is *not* scheduled (OQ26), so the shared
  window costs no live calls by default.
- **The two suites do not clobber each other's fixtures.** They share one
  `evalUserId`, and each teardown deletes the other's rows (`clearMemoryCorpus`
  removes every `Asset`; `clearEvalSource` removes every `Asset` and the `User`).
  Sequential execution (D19) makes this safe; the assumption is that no future
  change introduces concurrency or a second writer. Mitigation: T8 asserts the
  tick is serial and the `busy` flag is respected; the per-suite-user
  alternative is **OQ28**.
- **Scheduling stage 2 writes fixtures to the live database.** A scheduled
  stage-2 run seeds and clears `Session`/`Message`/`Asset`/`Task` under the
  reserved `evalUserId` in whatever Mongo the server is pointed at, including
  production. This is precedented (the tool-use suite already seeds/clears the
  same user on schedule) and is scoped to the reserved user, so it does not touch
  real users' data. It is stated, not hidden; if a non-production-only eval is
  wanted, that is a new ticket.
- **The eval's `WORKSPACE_MEMORY_ENABLED` is irrelevant.** The eval reads
  `enrichmentVotes` and `retrieveWorkspaceSlices` directly, neither of which
  consults `config.workspaceMemory.enabled`, so T9 needs only `ENRICHMENT_ENABLED`
  (default on) and provider creds. `WORKSPACE_MEMORY_ENABLED=1` belongs to T11
  (the live chat path), not T9. Verified this pass.
- **`metrics` on `EvalRunRecord` is additive.** Mongoose is strict by default, so
  `metrics` is an explicit sub-schema (T6), not "schemaless-safe". Adding fields
  needs no data migration; only the kind-scoped index needs a migration (D14). A
  backfill of `kind` on existing docs is included so old rows are unambiguous.
  The `countScores` interaction is **OQ27**.

## Task checklist

Each item is scoped to be safely deliverable as a single commit. "Verify" is the
per-item check; the final gate for every commit is `npm run ci` (exit 0).

### T0 — Promote this plan and point the repo doc at it  [DONE]

Deliverable: `docs/plan-289-workspace-memory.md` exists and the two docs do not
read as competing plans.

- Copy this file to `docs/plan-289-workspace-memory.md` (it currently lives only
  under `.iteration/`, which is git-ignored). Step: `cp
  .iteration/docs/plan-289-workspace-memory.md docs/plan-289-workspace-memory.md`.
- At the top of `docs/plan-289-gate-evals.md`, immediately under its H1, add:
  `> The remaining work on #289 is re-planned in
  [plan-289-workspace-memory.md](./plan-289-workspace-memory.md); where the two
  differ, that document is the forward plan.` Also rewrite that doc's
  **Follow-ups** section to defer to this one instead of listing the same items.
- **Fix the stale sentence** (done by the critic pass 7): Decision 1's Stage 3
  bullet no longer says "The judge is not wired in this increment"; it now reads
  "wired but not yet validated against hand labels (OQ1)". The stale OQ12
  two-case framing was corrected to the five bare-deixis positives, and a
  provenance caveat was added under the baseline.
- **Reconcile the gate baseline** (the pass-3 "no numeric reconciliation left"
  claim is false after T1b-i). `docs/plan-289-gate-evals.md` records the
  pre-annotation run (recall 83.3%, three misses); T1b-i's own run reads 88.9%
  with two misses and a changed corpus hash. Either re-run and update the repo
  doc's numbers, or state explicitly that the numbers are pre-annotation and T9
  is the re-capture. Do not leave the two docs disagreeing.
- Verify: `npm run format` then `npm run ci` (docs-only change, but the gate is
  the same for every commit).

### T1 — Grow the hand-labelled gate set  [DONE]

- `GATE_CASES` is n=36 (18 pos / 18 neg), with indirect refer-backs, history-only
  continuations, fresh-ask negatives, and a negative that follows history.
- `corpus.test.ts` invariants: minimum counts (≥ 30 total, ≥ 12 each label), both
  labels present, unique ids, unique prompts, note-provenance
  (`^(agent-authored|owner-confirmed)`), and history-only positives /
  history-bearing negatives.
- Subtype recording is **not** deferred here: it is unconditional corpus work in
  T1b-i (D20), because recording the subtype is useful whichever way OQ12 is
  judged. The adversarial-negative half of the old T1b is *not* a task (pass-6,
  OQ36): six memory-shaped negatives already exist, and a bare-deictic negative
  would collide with the existing bare-deictic positive `gate-and-that-one`.

### T1b-i — Record refer-back subtypes  [dep: none; before T9]

Deliverable: a gate set whose positives carry a subtype, so per-subtype bars are
possible.

- Extend `GateCase` (`types.ts`) with `subtype?: 'explicit' | 'continuation' |
  'bare-deixis'`; set it on **every** existing positive. Note the subtype counts:
  `explicit` 9, `bare-deixis` **5** (`gate-same-as-before`, `gate-other-one`,
  `gate-and-that-one`, `gate-previous-version`, `gate-one-from-yesterday`),
  `continuation` 4 (`gate-continuation`, `gate-continue-where-left`,
  `gate-finish-draft`, `gate-pick-up-tax`). The three recall misses are a subset
  of the five bare-deixis positives, not the whole subtype.
- Extend `corpus.test.ts`: every positive has a `subtype`; every `bare-deixis`
  positive has no `history` (so the label's ambiguity is explicit); the subtype
  counts are asserted so the set cannot silently rebalance.
- Do **not** add new gate cases here. The negative set is already six
  memory-shaped fresh asks plus a history-bearing fresh ask; adding a
  bare-deictic negative is gated on OQ36 (it collides with `gate-and-that-one`)
  and lives in **Follow-ups** until then.
- The corpus hash changes (D15), so T9 must re-capture the baseline **after**
  this task. Report per-subtype recall in the T9/T10 output.
- Verify: `npm run ci`; a local `npm run evals:memory` showing the per-subtype
  breakdown and a still-nonzero recall on `explicit`/`continuation`.

### T2 — Grow the retrieval / helpfulness scenarios  [DONE]

- `MEMORY_SCENARIOS` is n=22: `direct` 3, `paraphrase` 5, `file` 5, `task` 5,
  `deleted-seed` 2, `out-of-pool` 2 — clears the ≥ 20 / ≥ 5 (paraphrase, file,
  task) / ≥ 2 (deleted-seed, out-of-pool) bars.
- Four paraphrase variants share **no content word** with their seed; file facts
  live in `textExtracted`; task facts live in the `assistant` `TaskEvent` (#298).
- `corpus.test.ts` asserts per-scenario no-overlap, per-category minimum-N, and
  `expectedFact` in the expected seed (stage-3 backbone reachability).
- Live retrieval run: expectedMet 77.3% / surfacedRate 59.1% (n=22). Corpus
  pushed to `tova-memory-evals`.

### T3 — Stage-3 deterministic backbone  [DONE]

- Delivered as `runHelpfulnessEval` in `helpfulnessEval.ts`: per scenario it
  clears, seeds, reads `retrieve(query, evalUserId)` once, derives the block from
  that same read (ids and block cannot diverge), runs both arms, and records
  `{ blockCarriesId, factInBlock, factHitWith, counterfactualHit }`.
- The counterfactual is **run**, not assumed: the blank-block arm is answered,
  and when the block is empty the with-arm answer is reused (the two arms would
  be byte-identical).
- Unit + integration tests pin the loop and the no-block skip.

### T4 — Pairwise, blinded, position-swapped judge  [DONE]

- Delivered in `helpfulnessEval.ts` (`buildJudgePrompt`, `parseJudgeVerdict`,
  `resolveSwappedOutcome`, `defaultJudge`): blinded prompt, two calls with the
  arms swapped, only an order-consistent win is a win.
- Judge model from `config.memoryEval`; tags `memory-eval:helpfulness:judge` and
  `memory-eval:helpfulness:respond` for the LangSmith sanity check (T11).
- Divergence from the earlier plan sketch (recorded, not hidden): the judge lives
  in `helpfulnessEval.ts` (not a separate `judge.ts`), the fold is
  `resolveSwappedOutcome` returning `win|loss|tie` (not `resolveVerdict`
  returning `with|without|tie|error`), and there is no `error` verdict. T14b
  closes the `error` gap.

### T14a — `normaliseFact` (stage-3 hardening)  [DONE]

- Add `normaliseFact(fact)` (casefold + collapse internal whitespace + trim) in
  `helpfulnessEval.ts`, and route **both** the block check and the answer check
  through it. This closes the newline/double-space false miss the shipped
  `containsFact` has.
- Unit-test: a fact split by `\n` / double spaces in the answer still matches;
  a genuinely absent fact still misses.
- Residual fairness is OQ22. Verify: `npm run ci`.

### T14b — Judge `error` outcome distinct from `tie`  [DONE]

- Make `parseJudgeVerdict` (or its caller) return a distinct `error` for an
  empty/unparseable reply, and give `resolveSwappedOutcome` /
  `helpfulnessMetrics` an `errors` count separate from `ties`.
- **Also catch a *thrown* judge/provider error** (a Groq 429/timeout that
  `defaultJudge` currently lets propagate) into the same per-case `error`
  outcome, so a dead judge is counted, not an abort. Safe default: **record and
  continue**; whether the run should instead abort is OQ30. This is the fix for
  the pass-4 defect 1.
- The mechanism is built regardless of the OQ20/OQ30 denominator policy (errors
  are reported as their own count; whether they enter the denominator is a
  reporting choice). This is what T5 validates.
- Verify: `npm run ci` plus unit tests that (a) an unparseable reply is `error`,
  not `tie`, and (b) a judge that throws is recorded as `error` and does not
  abort the run.

### T14c — Configurable responder (stage-3 hardening)  [DONE]

- Add `config.memoryEval.responderModel`/`responderProvider`/`responderTemperature`
  (defaults to the current `resolveScheduledModels({})` / `0`) and have
  `defaultRespond` read them. No behaviour change by default. Config-sourced, not
  ad-hoc `process.env` (#142).
- Verify: `npm run ci`; a config test that the override is honoured.

### T14d — Live judge preflight (stage-3 hardening)  [DONE]

- Delivered: `scripts/run-memory-evals.ts --preflight-judge` issues one judge call
  to `config.memoryEval.judgeModel` over a fixed constructed pair and asserts a
  **parseable** verdict (not merely a non-error reply), and prints the raw
  completion so truncation is visible. It **raised the token budget** when the
  16-token default truncated the reasoning model (this closed OQ21).
- If it fails, stop and raise on #289 — do not silently substitute a model.
- Verify: a local `--preflight-judge` run against Groq; `npm run ci`.

### T14e — Exception-safe fixture cleanup  [DONE]

- Wrap the per-scenario body of `runHelpfulnessEval` (`:237-274`) and
  `runRetrievalEval` (`:174-194`) in `try { … } finally { await clear(); }`, so a
  thrown responder/judge/provider error cannot leak seeded rows under the shared
  `evalUserId` (pass-4 defect 2). Today only the *final* `clear()` after the loop
  runs, and it is skipped on any throw — which then corrupts the next run and the
  tool-use suite (OQ28).
- The gate runner (`runGateEval`) does not seed fixtures, so it is out of scope.
- Unit-test with a `respond`/`retrieve` fake that throws on the second scenario
  and assert `clear` was called on the way out.
- Verify: `npm run ci`.

### T14f — Responder generation budget guard (stage-3 hardening)  [dep: none; before T9]

- The stage-3 responder uses `max_tokens: 512` (`helpfulnessEval.ts:232`); a fact
  late in a long answer can be truncated, scoring a backbone miss for a
  generation-budget reason (pass-5 doubt; the responder analogue of OQ21).
- **Blocker found this pass:** `NeutralCompletion` (`llmTypes.ts:100`) exposes
  only `choices[].message.content`, `toolResults` and `usage` — there is **no
  `finish_reason`** on the connector shape. Flagging truncation therefore needs a
  connector-shape change (thread `finish_reason` through every connector's
  `createToolFreeCompletion`, or a provider-specific side channel), not a local
  guard. Scope the task as: (1) raise the responder budget to a value that cannot
  truncate a normal answer; (2) plumb `finish_reason` (or an equivalent
  truncation signal) through `NeutralCompletion`; (3) record `finishReason` per
  case and flag `length`. If the connector change is judged too invasive for this
  ticket, split step (2)/(3) to a follow-up and ship only the raised budget with a
  written caveat that truncation is unobserved (not unobservable).
- Whether a raised budget is still production-faithful is **OQ34**; the safe
  default (raise + record truncation) is unconditional, so no task depends on the
  answer.
- Verify: `npm run ci`; a unit test that a `finishReason: 'length'` completion is
  flagged per case, and that a normal completion is not.

### T15a — Enrichment precondition for the gate stage  [DONE]

- Add a `assertEnrichmentEnabled()` guard (in `memoryEvalService.ts`, called at
  the top of `runGateEval` or by the CLI before the gate stage) that reads the
  same predicate `enrichmentVotes` uses (`isEnrichmentEnabled`,
  `enrichmentService.ts:31`; `ENRICHMENT_ENABLED` defaults **on**) and **throws a
  clear message** (`'memory gate eval requires ENRICHMENT_ENABLED; enrichmentVotes
  returns all-false when off, which would score recall 0'`) rather than silently
  posting a 0% gate. `isEnrichmentEnabled` is module-private today, so either
  export it or read `config` through a tiny helper — do not duplicate the
  env-parsing predicate.
- The baseline ran with the default (on), not by luck; make the requirement
  explicit so a future `ENRICHMENT_ENABLED=0` run cannot silently post a 0% gate.
- Verify: `npm run ci`; a test that the guard throws with `ENRICHMENT_ENABLED=0`
  (stub the env/config getter) and passes with it on/unset.

### T15b — Gate provider-failure distinctness  [DONE]

- `runGateEval` records per-case `{observed, failed}` where a provider/parse
  failure is `failed`, not a `no` (D7, OQ11). This needs
  `classifyFileIntent`/`enrichmentVotes` to stop swallowing errors into
  both-false — add a **strict eval seam** (a variant, or an optional error
  channel the eval can read) without changing the production chat path's
  never-throw behaviour. Concretely: `classifyFileIntent` currently catches every
  error and returns `{files:false,workspace:false}` (`enrichmentService.ts:159`);
  the eval needs a path that distinguishes "the model said no" from "the call
  failed", e.g. a `classifyFileIntentStrict` that rethrows, consumed only by the
  eval.
- **Cover the timeout path too (pass-5 defect 2).** `enrichmentVotes` resolves a
  `ENRICHMENT_TIMEOUT_MS` (1500ms) expiry to `{workspace:false}`
  (`enrichmentService.ts:192`), which the strict `classifyFileIntent` seam does
  **not** bypass. Either (a) the eval calls the classifier directly with no
  timeout, (b) the cap is raised for the eval, or (c) the timeout is recorded as a
  distinct `timeout` outcome — the choice is OQ33; the safe default implemented
  here is to record it distinctly (a `timeouts` count), so a slow aux call is
  never silently a false negative.
- `gateMetrics` gains `errors` and `timeouts` counts (excluded from the
  precision/recall denominator by default; the denominator policy is OQ11). Add
  them to the `GateCaseResult` row too, so a per-case drill-down can show which
  case failed and why.
- Verify: `npm run ci`, plus a gate run with (a) a forced provider failure
  asserting it is counted as `failed`, not `falseNeg`, and (b) a forced timeout
  asserting it is counted as `timeouts`, not `falseNeg`.

### T15c — Gate pacing / retry  [DONE]

- Serialise gate calls with a small delay/backoff so a 36-case burst does not
  trip the Groq 30 RPM limit; a 429 becomes a recorded `failed` (T15b), not a
  false negative.
- Concretely: add an injectable `pace` seam to `runGateEval` (mirroring T15d's
  `HelpfulnessDeps.pace`), defaulting to a config-sourced delay (a new
  `config.memoryEval.gatePaceMs`, or reuse `paceMs` if one knob is preferred),
  awaited before each `classify` call; tests inject a no-op. Retry policy is the
  open part (OQ32): the safe default is **pace only, no retry**, so a 429 is still
  recorded as `failed` rather than masked.
- Verify: `npm run ci`; a local gate run of all 36 cases that completes without a
  429 (watch for `Rate limit reached`).

### T15d — Stage-3 pacing  [DONE]

- Serialise the stage-3 responder and judge calls with a small inter-call delay
  so a full `--helpfulness` run (~2 responder + ~2 judge calls per judged
  scenario, ≥ 44 judge calls at n=22) does not trip the judge provider's RPM.
  Combined with T14b (a thrown 429 is recorded as `error`, not an abort), a
  rate-limited run degrades to a partial result instead of a crash.
- The *exact* budget/policy (fixed delay vs provider-aware backoff, retry vs
  not) is **OQ32**; this task implements the safe default unconditionally, so it
  does not depend on the answer.
- Verify: `npm run ci`; a local `--helpfulness` run that completes without a 429.

### T5 — Judge validation harness (constructed + hand labels)  [DONE; dep: T14b, T14d]

Deliverable: a reproducible agreement number for the judge, plus the loading
path for the hand labels that will (owner-permitting) replace the constructed
set as evidence.

- New `apps/server/src/evals/memory/judgeValidation.ts`:
  - `JudgeLabel = { id, query, answerA, answerB, better: 'A' | 'B' | 'tie',
    provenance: string }` — one labelled pair.
  - a **constructed** set whose correct arm is known by construction (with-arm
    contains the seeded fact; without-arm does not), each carrying
    `provenance: 'constructed'`;
  - a **hand-labelled** set loaded from a checked-in JSON file
    (`corpus/judge-labels.json` or inline), each carrying `provenance:
    'agent-authored' | 'owner-confirmed'` (mirrors the gate `note` convention,
    OQ1);
  - `judgeAgreement(labels, judgeFn)` → `{ n, accuracy, kappa, confusion }`,
    where `kappa` is Cohen's kappa over the three classes and `n` is the count.
    Return `null` kappa when a class is absent.
- Extend `scripts/run-memory-evals.ts` with `--validate-judge`, which runs
  `judgeAgreement` over the constructed set (always) and the hand set (when
  present), prints both with their `n` and provenance, and labels the
  constructed number a smoke test (not evidence).
- Honesty: the constructed set is circular (see Assumptions) and is not
  evidence. Trusting the judge at scale needs the ≥ 30 hand-labelled pairs
  (OQ1/OQ4). Record the constructed-set agreement as the interim signal and stop
  there.
- **This task builds and tests the harness without owner input. The "judge is
  trusted" acceptance criterion is owner-gated on OQ1** and cannot be met by the
  agent alone; the task reports the constructed-set agreement and completes.
- Verify: `npm run ci`, plus a local `--validate-judge` run against Groq.

### T6 — Persist memory metrics (server)  [dep: none]

- Extend `EvalRunRecord` (`apps/server/src/models/EvalRunRecord.ts`):
  - `kind: { type: String, enum: ['tool-use', 'memory'], default: 'tool-use' }`;
  - a typed `metrics` sub-schema with **all three stage fields optional** (a
    scheduled retrieval-only run writes no `gate`/`helpfulness`): `gate`
    (`precision`, `recall`, `fireRate`, `tp/fp/tn/fn`, `errors`, `timeouts`,
    `total`, `gateModel`, `corpusHash`, `recallBySubtype` for D20), `retrieval`
    (`expectedMetRate`, `surfacedRate`, `byCategory`, `total`), and `helpfulness`
    (`wins`, `losses`, `ties`, `errors`, `winRate`, `judged`, `factHitRate`,
    `blockIdRate`, `counterfactualHits`, `deterministicWins`, the per-category
    breakdown for OQ14, and the
    **`responderModel`/`responderProvider`/`judgeModel`/`judgeProvider`**
    identities for D15/OQ29). Also record `stages: string[]` so a partial run is
    self-describing.
- Add `corpusHash` via a helper (D15): SHA-256 over the canonical JSON of
  `GATE_CASES` + `MEMORY_SCENARIOS`; test that a one-character label edit changes
  it.
- Add the `{kind:1, startedAt:-1}` index via a new migration next to
  `20261007000000-create-eval-runs.ts`; backfill `kind: 'tool-use'` on existing
  docs; no data migration is otherwise needed.
- Add a `stages` selector to `runMemoryEvals` (`memoryEvalService.ts:198`) —
  `('gate'|'retrieval')[]`, defaulting to both for the manual CLI — and thread it
  through the runner. This is required so T8 can schedule **retrieval only**
  without making the 36 live gate calls unattended (pass-5 defect 4; D13/OQ26).
- Add `beginMemoryEvalRun`/`executeMemoryEvalRun`/`startMemoryEvalRun` in
  `evalRunService.ts` (or a sibling `memoryEvalRunService.ts` if the shapes
  diverge), reusing the **global** lease (D14, corrected), taking the `stages`
  selector (default `['gate','retrieval']`), running `runMemoryEvals`, writing the
  sentinel `results` and the partial `metrics` payload, settling `done`/`error`.
  **`models` is the snag:** `beginEvalRun` (`evalRunService.ts:327`) maps
  `StartEvalRunOptions.models` (`{provider, model}[]`) to `${provider}:${model}`
  keys, so a raw `['memory']` string list neither type-checks nor lands. Pick one:
  (a) reuse `beginEvalRun` with the sentinel `[{provider:'memory',
  model:'memory'}]` → `models:['memory:memory']` (simplest; the admin list shows
  `memory:memory`); or (b) add a dedicated `beginMemoryEvalRun` that writes
  `models:['memory']` directly. D9's wording says `['memory']`; take **(b)** so the
  displayed value matches D9, and have the shared `executeEvalRun` settle the
  record (or a sibling executor if the settle shape diverges). `models[]` must not
  be empty or the run reads as model-less in the admin list.
- Extend `evalRunsAdminService.ts` + `AdminEval*` contracts with optional
  `kind`/`metrics`. **Leave `countScores` unchanged** (D9 default): memory rows
  appear in the same summary counts and are disambiguated by the `kind` badge.
  OQ27 is a confirmation of that default, so this task does not wait on it; a
  kind-scoped summary is a follow-up if the owner asks.
- Server tests: a memory run writes one `kind:'memory'` doc with the metrics
  payload; a crash writes `status:'error'`; a `retrieval`-only run writes no
  `gate`/`helpfulness` metrics; two runs of **different** kinds cannot both be
  live (global lease), while a memory run today does not suppress a *later*
  tool-use run in the same window (kind-scoped idempotency).
- Verify: `npm run ci`.

### T7 — Surface memory metrics in the admin Evals tab (client)  [dep: T6]

- `AdminEvalsView.tsx`: for `kind:'memory'` runs render the continuous rollup
  (gate precision/recall/fire-rate, retrieval recall@k, helpfulness win-rate,
  each with `n`, plus error/tie counts) alongside the existing per-case
  drill-down. Put `metrics` on `AdminEvalRunDetail` (not the list row) so the
  list query stays light; show a `kind` badge on the list row.
- **Mobile-first**; verify at ~375px with the `playwright-cli` skill (no
  horizontal overflow).
- Client tests (mock the service): memory-run row + metric render, tool-use
  rows unchanged.
- Verify: `npm run ci:client`, then `npm run ci`.

### T8 — Wire the memory suite into the scheduled suite  [dep: T6]

Deliverable: the memory **retrieval** stage runs once per scheduled window,
sequentially with tool-use, under the **global** lease with kind-aware
idempotency. **Stage 1 is not scheduled here** (OQ26); **stage 3 is not
scheduled** (D13/OQ6). The task depends on no open question.

- Make **idempotency** kind-aware: `hasRunForUtcDay(now, kind)`,
  `reclaimStaleEvalRuns(maxAgeMs, kind?)`, and the `{kind:1, startedAt:-1}` index
  (T6). Leave `findRunning` **global** (D14, corrected pass 5): the suites share
  `evalUserId`, so a cross-kind overlap must stay blocked. A test asserts a live
  memory run rejects a tool-use `beginEvalRun` and vice versa.
- Restructure `startEvalScheduler` so one tick can run **both** suites: the
  tick's single `hasRun` gate must not skip both when only one kind has run.
  Move per-kind idempotency into the run callback (or pass a per-kind `hasRun`).
  Run tool-use via `startEvalRun`, **await it to completion**, then run memory
  stage 2 via `startMemoryEvalRun({ stages: ['retrieval'] })` — the `stages`
  selector from T6 is what keeps the live gate off the unattended path
  (pass-5 defect 4). Strictly sequential, never `Promise.all` (D19). The existing
  `busy` flag already prevents tick stacking; assert it in a test.
- Resolve the memory stage's model identities at the composition root
  (`apps/server/src/index.ts:172`) from `config` (`config.aux.*` for the gate,
  `config.memoryEval.*` for the judge) — not ad-hoc `process.env` (#142). The
  scheduled `['retrieval']` path needs none of them; wiring them here is what
  makes a future stage-1/stage-3 schedule a config change, not a code change.
  Default schedule stays `off`.
- Scheduler tests: both suites run once per window; per-kind idempotency (tool-use
  already run today does not suppress memory, and vice versa); the two runs never
  overlap (a fake second suite cannot observe the first suite's fixtures); memory
  failure does not block the tool-use suite (and vice versa).
- Verify: `npm run ci`.

### T9 — Enlarged baseline (all three stages)  [dep: T1b-i, T14a, T14e, T14f, T15a–d]

Deliverable: a recorded, reproducible baseline for all three stages, and the
run-to-run delta that tests the determinism assumption.

- Prerequisites: local stack up (`npm run stack:up`), `ENRICHMENT_ENABLED` on
  (the default), provider creds present (`GROQ_API_KEY`, the DeepInfra responder
  key). `WORKSPACE_MEMORY_ENABLED` is **not** required — the eval does not read
  it (verified this pass).
- Command: `npm run evals:memory -- --helpfulness`. It prints stages 1–2 **and**
  3; there is no `--all` flag and none is needed. Run it **twice** and diff the
  numbers.
- Capture, per stage and per category, into a table in
  `docs/plan-289-gate-evals.md` (baseline section):
  - gate: `precision`, `recall` (overall **and per subtype**), `fireRate`,
    `tp/fp/tn/fn`, `failed`, `timeouts`, `n`, gate model;
  - retrieval: `expectedMetRate`, `surfacedRate`, `byCategory`, `n`;
  - helpfulness: `winRate`, `wins/losses/ties/errors`, `judged`, `factHitRate`,
    `blockIdRate`, `counterfactualHits`, `deterministicWins`, `n`, responder +
    judge models;
  - run-to-run delta for every rate above.
- Push the enlarged corpus to `tova-memory-evals` **once**, not once per pass:
  the CLI pushes whenever `LANGSMITH_API_KEY` is present, so the mandated
  double-run would duplicate every example (OQ31). Unset the key for the second
  run (or push only after the second), and queue the summary as a comment on
  #289.
- Stage 3's win-rate is recorded **provisional** until T5 + hand labels validate
  the judge (OQ1). If the two runs disagree on any rate, that is a finding: record
  it and flag that it blocks ratification (OQ26).
- Verify: the CLI exits 0; the by-construction misses still miss; the gate
  `failed` count is zero or reported (never silently folded into `falseNeg`).

### T10 — Propose thresholds for ratification  [dep: T9]

Deliverable: a proposal table for all three stages, each bar with a companion
floor and a stated minimum N. The task **depends on no open question**: it
proposes from the T9 numbers and states the caveat where the instrument is not
yet trusted.

- Assemble the table from the T9 baseline, one row per metric with columns
  `stage | metric | proposed bar | companion floor | minimum N | value @ baseline
  | caveat`. Concretely:
  - **stage 1 (gate):** `precision ≥ X` **with** a `recall ≥ Y` / `fireRate`
    floor, overall and per subtype (D20). Confirm or amend the ~70–80% ship
    target. Cite `tp/fp/tn/fn` and `n`. State explicitly that the measured
    precision is at the corpus's **50% positive prevalence**, not the live base
    rate, and either add a prevalence-adjusted line (reweight by T11's dev vote
    rate) or mark the bar "corpus-prevalence" (OQ40).
  - **stage 2 (retrieval):** recall@k, using whichever of `surfacedRate` /
    `expectedMetRate` OQ25 settles on — propose both readings until then. Note
    that `expectedMetRate` credits the by-construction misses as passes and is a
    corpus-conformance number, not retrieval quality.
  - **stage 3 (helpfulness):** pairwise win-rate `≥ Z` with the tie/error policy
    (OQ3/OQ20) stated. Mark it **provisional, judge unvalidated** until T5's
    hand labels exist (OQ1); the bar is not ratified off an unvalidated judge.
    State that the judged set excludes every by-construction miss (OQ14), so the
    bar is "helpfulness where retrieval fires", not overall.
- For each bar, derive (or state) the minimum N from the T9 variance where
  possible; where it is still a rule of thumb, say so (OQ5).
- Deliverable is the proposal table; the owner ratifies, with OQ1/OQ4/OQ5
  supplying the final input. Record the ratified table in this plan and on #289.
- Verify: every bar in the table names a floor, a minimum N, the exact metric it
  is computed from, and its prevalence/fidelity caveat.

### T11 — Manual LangSmith sanity check  [dep: T9]

Deliverable: a written comparison of the *live-path* injection behaviour against
the *eval* numbers, so the automated metrics are not the only evidence.

- On the local stack, set `WORKSPACE_MEMORY_ENABLED=1` and restart the dev
  server (the flag is read at call time via `config.workspaceMemory.enabled`, so
  a restart is the clean path). Sign in with `npm run db:password` + `password`.
- Drive a handful of turns that seed a fact in one chat and probe it from a
  fresh chat (the real usage pattern from the ticket). Confirm the block is
  injected and the answer uses it. Use the dump's real pattern (owner comment,
  2026-10-13): seed in a longer-lived chat, probe from a fresh one.
- Read `tova-dev` traces (the `LANGCHAIN_*` creds in `.env`): filter the
  `enrichment:votes` runs to get the gate's vote per turn, and read the chat runs
  for the rendered block; read the T9 `memory-eval:helpfulness:judge` and
  `:respond` traces too. Record the vote **rate** (fired / total) and a
  qualitative judgement on the injected block (right fact? noisy? stale?).
- Record explicitly that the dev vote rate is over ad-hoc turns while the eval
  fire-rate is over the synthetic 50%-positive corpus — a smell test, not an
  equality. Flag any turn where the live block is wrong, since the eval's
  precision cannot see a bad-but-fact-carrying block.
- Deliverable: the finding appended to this plan / posted on #289. No code.

### T12 — Decide the assistant-turns corpus question  [dep: T9]

Deliverable: a recorded decision (keep or widen) with the evidence that settles
it.

- Use the T9 per-category retrieval numbers. The decisive evidence is whether
  any expected fact lives *only* in an **assistant `Message`** turn (today
  `collectWorkspaceSlices` indexes `role:'user'` messages only). Note the
  task-artifact case is **not** affected: `seedTask` puts the fact in an assistant
  `TaskEvent`, and the task slice reads the whole `user`/`assistant` `TaskEvent`
  stream in `seq` order (`memorySource.ts:73-74`), so it surfaces today. The
  open case is only `Message`-role assistant turns.
- Concretely: scan `MEMORY_SCENARIOS` for any scenario whose `expectedFact` would
  be absent if assistant `Message` turns were the only carrier. If none exists,
  the as-is decision is evidence-backed; if one does (or the owner wants a
  probe), widening is justified.
- Record the decision + rationale in this plan and on #289.
- **Widening, if chosen, is a new follow-up ticket** (it touches
  `collectWorkspaceSlices` and the pool/cap logic), not a drive-by change here.
- No code in this task.

### T13a — Go/no-go recommendation for live  [dep: T9–T12, T10]

Deliverable: a written recommendation with the kill switch, for the owner's
call. **This task does not wait on ratification** (pass-4 defect 4): it cites
the *proposed* T10 bars and states each caveat where a bar is not yet ratified.

- State the recommendation in one of three explicit forms — **go**, **no-go**, or
  **go-on-a-named-subset** (e.g. enable only if the gate precision floor is met
  but leave stage 3 unmeasured) — citing the T9 numbers against the **proposed**
  T10 bars, and naming which bars are provisional (the stage-3 win-rate is "judge
  unvalidated" until T5/hand labels; the deterministic bars are proposed pending
  OQ1/OQ5).
- State the kill switch exactly: blank `WORKSPACE_MEMORY_ENABLED` (or set it to
  `0`) and restart the container; confirm the default is off
  (`config.workspaceMemory.enabled`, `config/index.ts:107`).
- State the residual risks explicitly, each with the OQ that owns it: unvalidated
  judge (OQ1/OQ2), shared-eval-user scheduling caveat (OQ28/OQ35), judge/provider
  failures (OQ30/OQ32/OQ33), gate silent-failure paths (OQ11/OQ33), and the
  base-rate/prevalence gap between the corpus precision and live (OQ40).
- Deliverable: the recommendation in this plan and on #289.

### T13b — Owner ratification + flag flip  [dep: T13a; owner-gated]

- The owner ratifies (or amends) the T10 bars with OQ1/OQ4/OQ5 resolved, then
  makes the live go/no-go call. If "go", flip `WORKSPACE_MEMORY_ENABLED=1` and
  record the ratified table + decision on #289. If "no-go", record why and leave
  the flag off.
- **This is an owner action, not an agent task** — it is listed so the plan's
  terminal step is explicit and so no agent task is blocked waiting on it.

## Open questions

Honest list. Each says what, if anything, it gates — and no agent task above
depends on an answer to execute (the tasks that consume answers are T10, T12 and
T13a, which *produce* input rather than being blocked; T5's harness is built
without owner input; the only owner-gated terminal step is **T13b**).

**Resolved by the ticket / issue comments (NOT open):**

- The stage-3 **bar type** (pairwise judge win-rate), the **backbone**
  (`expectedFact` containment), the **counterfactual** requirement, and the
  **judge model** (`gpt-oss-120b`) are owner decisions in the ticket body;
  they are D2/D4/D5/D10.
- The **position-swap mechanism** (judge twice, arms swapped, blinded) is D6;
  only the disagreement/tie scoring (OQ3) remains open.
- **Prompt-assembly fidelity (was OQ15) is closed as a decision (D17):** the
  with-arm is assembled through the production `buildSystemContent`. The
  residual — a null user and no file library — is OQ23.
- **Corpus synthetic / out-of-pool burial** is owner-decided (D16).
- **RAG headroom categories** (paraphrase, out-of-pool, task/file) are fixed by
  the ticket and implemented (T2).
- **Substring containment is the backbone (was OQ7) is closed:** the ticket fixes
  it ("assert the answer contains the expected fact"), so it is a decision, not a
  question. Only the normalisation residual (OQ22) remains.
- **Judge token budget (was OQ21) is closed as a decision (D2).** The T14d
  preflight confirmed live that `max_tokens: 16` truncated the reasoning model to
  an empty completion; the budget is now `JUDGE_MAX_TOKENS = 512` and the
  preflight asserts a **parseable** verdict in both orders on every run, so a
  future truncation fails loudly. No open question remains here.

**Owner decisions the plan schedules from evidence (not methodological
unknowns):**

- **OQ9 — Assistant-turns indexing.** Decided from evidence by T12; widening is a
  follow-up ticket, so no task here depends on the outcome.
- **OQ10 — Live go/no-go.** Owner decision; T13 produces the recommendation and
  the documented kill switch.

**Open (methodological or policy):**

- **OQ1 — Label independence (gates T10 ratification and T5's trusting step).**
  Who authors and validates the hand labels (gate set, judge-validation pairs,
  scenario expectations), and does agent-authored labelling count as
  "hand-labelled"? If the same agent authors the corpus and tunes the gate, the
  labels are not independent evidence. T1/T2/T5 record the labelling source so
  this is auditable.
- **OQ2 — Judge independence (gates trusting the judge).** The judge is
  `gpt-oss-120b`; the gate is `gpt-oss-20b` — same family. Is "not the gate
  model" sufficient, or does avoiding self-preference require a different family
  entirely? The judge id is config-sourced, so the answer is a config change.
- **OQ3 — Position-swap scoring (gates the stage-3 metric definition).** D6 fixes
  the mechanism; the open part is how to score an order-disagreement (`tie` vs
  loss) and whether a tie is 0 or 0.5 in the win-rate. The shipped
  `resolveSwappedOutcome` + `helpfulnessMetrics` already score a tie as 0.5;
  D10's text says ties are excluded from the denominator, so the code and D10
  disagree until OQ3 is settled.
- **OQ4 — Helpfulness floor (owner call).** The bar is pairwise judge win-rate
  (D5); what is the floor (e.g. ≥ 60%)? T14/T5 produce the raw signal regardless;
  T10 proposes a number from the baseline.
- **OQ5 — Minimum N (owner/statistical call).** Are 30/20/5/30 defensible, or
  should N be derived from observed variance (e.g. a binomial CI)? D11 treats
  them as provisional; T10 may revise them from the baseline.
- **OQ6 — Stage-3 on the unattended schedule (cost/quota).** Should the daily
  memory run include the live judge/responder calls, or stay manual-only?
  D13/T8 keep stage 3 out of the scheduled path, so this only affects a future
  change.
- **OQ11 — Provider-failure handling (denominator policy).** D7 fixes the
  mechanism (record failures distinctly, pace under the RPM — T15b/c); the open
  part is whether a provider `error` is excluded from the precision/recall
  denominator or counted (as a false negative for a positive case). The runner
  records the outcome either way, so the policy is an aggregation choice.
- **OQ12 — Are the bare-deixis labels fair? (corrected pass 6: the whole
  subtype, not just the misses.)** The corpus has **five** bare-deictic
  positives with **no history** — `gate-same-as-before`, `gate-other-one`,
  `gate-and-that-one`, `gate-previous-version`, `gate-one-from-yesterday` — not
  the two the gate missed. With no history the referent is unresolvable in the
  input the gate sees, so `refersBack: true` asserts the gate *should* fire on
  bare deixis. Three of the five the gate got right and two it missed; if the
  owner judges the subtype unfair, all five are affected, and the bar cannot be
  set from the two misses alone (the prior "recall rises to 94.4% (34/36)"
  framing only relabels the two). `gate-finish-draft` is a `continuation` with
  history, so it is unaffected. **T1b-i/D20 records the subtype on every positive
  unconditionally**, so this is a *judgement*, not a corpus blocker: per-subtype
  recall is reported and the bare-deixis bar is set to 0 (or dropped) if judged
  unfair. Ties into OQ1 (label independence) and **OQ36** (the subtype's label is
  also inconsistent with the bare-deictic negative T1b had proposed).
- **OQ13 — Responder/judge sampling and repeats.** D3 pins the responder at
  `temperature: 0`, but the ticket fixes only the judge model, not sampling.
  Should the responder (and judge) be repeated k times per arm with the median or
  majority verdict, or is a single `temperature: 0` call enough? A
  non-deterministic responder inflates the A/B delta with sampling noise.
- **OQ14 — Stage-3 denominator.** Should the reported helpfulness win-rate be
  over all scenarios or only `expectSurfaced: true` scenarios? On a
  by-construction miss the injected block is empty, so with == without and the
  pair is a tie that measures retrieval, not injection. **The shipped `judged`
  denominator is a third set** — cases with a non-empty block — which can include
  a `expectSurfaced:false` scenario that happened to surface. **Expanded pass 8:**
  the non-empty-block set **excludes every by-construction miss** — all five
  `paraphrase` cases, both `deleted-seed` cases and both `out-of-pool` cases — so
  the stage-3 win-rate is measured *only where retrieval already fires*, and the
  RAG-headroom cases (the ones #293/#294 exist to move) contribute nothing to
  helpfulness. That is arguably the right production question ("given the block
  fired, did it help?") but it means stage 3 cannot show a retrieval improvement's
  downstream effect. D8 records the breakdowns so the choice is a reporting
  decision; decide which set is the bar, and whether a "helpfulness given a fired
  block" reading needs a companion "overall" line.
- **OQ16 — Model pinning / baseline invalidation.** The gate reads
  `config.aux.model` live, so changing `AUX_MODEL` silently changes the thing the
  baseline measured. Should the eval pin the gate model, and should a model change
  invalidate a ratified threshold (forcing re-ratification)? D15 records the
  model and corpus hash so the change is visible; the policy is open. Stage-3's
  models have the same problem and their recording is **OQ29**.
- **OQ17 — Does the judge add signal?** On a synthetic personal-fact corpus the
  without-arm almost always fails, so a pairwise win is near-guaranteed and the
  judge may merely re-express the substring check. Does the corpus need
  "plausible-without" scenarios (fact inferable from general knowledge, or a
  partly noisy block) for the judge to earn its place, or should stage 3 be
  reported as a determinism check? T14/T5 build the machinery either way.
  **T5 evidence (2026-10-14):** the judge disagreed with the substring backbone on
  36% of constructed pairs (63.6% accuracy), preferring a fluent refusal over a
  terse fact fragment — so it does **not** merely echo the substring rule, but it
  also is not a fact-containment oracle. That is signal *for* OQ17's "judge adds
  something" reading and a caveat for the stage-3 bar (terse injected facts can
  lose to refusals).
- **OQ18 — Stage-3 fact reachability through the block window (mitigated by a
  test).** D4/D10 assert the with-arm *block* carries the expected fact, but the
  block is `matchSnippet` (a 160-char window centred on the prompt match) under a
  1200-char cap. A future scenario whose fact sits outside the window, or a
  multi-slice scenario where the expected slice is pushed out of the cap, would
  fail stage 3 for a fixture reason, not a helpfulness one. Guarded by an
  integration invariant (`memorySource.test.ts`), but the *design* choice is
  open: assert the fact against the surfaced slice's full text (isolates the
  fixture from block layout) or against the rendered block (production fidelity)?
- **OQ19 — Is the negative set adversarial enough for precision to be
  evidence? (premise corrected pass 6.)** The gate scores precision 100% on 18
  negatives. Eleven are easy fresh asks (capital of Australia, a poem, the time,
  arithmetic); **six are already memory-shaped fresh asks**
  (`gate-fresh-job-advice`, `gate-fresh-dinner`, `gate-fresh-trip`,
  `gate-fresh-exercise`, `gate-fresh-bakery-names`, `gate-fresh-recipe`) and one
  follows history without referring back — so the set is *not* only easy asks.
  Precision is the ship metric (~70–80% target) and is base-rate blind, so its
  credibility rests on the negatives being memory-shaped fresh asks the gate must
  decline. The remaining judgement is whether the six are adversarial *enough*
  (they still carry a topic word — "about my job" — unlike bare deixis), or
  whether bare-deictic negatives are needed — which is gated on **OQ36**, since a
  bare-deictic negative collides with the bare-deictic positive
  `gate-and-that-one`. Ties to OQ1/OQ12/OQ36.
- **OQ20 — Judge failure vs tie: the denominator/reporting policy (mechanism now
  landed).** T14b landed the distinct `error` outcome: `parseJudgeVerdict` returns
  `error` for an empty/unparseable reply, `resolveSwappedOutcome` returns `error`
  if either presentation errored, and `helpfulnessMetrics.errors` is separate from
  `ties` and **excluded** from the win-rate denominator. The open part is the
  *policy*: is excluding errors right, or should a run with a high error rate be
  flagged (e.g. refuse to report a win-rate above some error fraction)? How should
  the report surface a run where many pairs errored? (The mechanism is no longer
  open; only the reporting rule is.)
- **OQ22 — `normaliseFact` residual (mechanism now landed).** T14a landed
  `normaliseFact` (casefold + whitespace-collapse) and routed both the block and
  the answer checks through it, so a fact spanning a newline/extra spaces no longer
  false misses. The residual is whether normalisation can **mask** a genuinely
  absent fact (e.g. a fact split across the block and the answer, or a
  case-collapse that matches unrelated text). No code task depends on the answer.
- **OQ23 — With-arm assembly fidelity (new, replaces part of OQ15).** The eval
  calls `buildSystemContent(null, null, true, null, block)` — no user profile, no
  file-library block, `includeDate=true`. In production the block competes with
  the profile and library sections for attention and for the model's context.
  Does the stripped-down assembly overstate helpfulness, and should the eval
  materialise a user + library to match production?
- **OQ24 — Responder model coverage (new).** Stage 3 pins one roster model
  (D3). Memory injection may help or hurt different roster models differently;
  a win-rate from one model may not generalise to the pool the router selects
  from. Is one responder enough for the go-live decision, or should stage 3 sweep
  the roster (cost grows linearly)?
- **OQ25 — Which retrieval number is the bar? (new).** The ticket says retrieval
  is measured as recall@k, but the baseline foregrounds `expectedMetRate` (77.3%),
  which **credits the by-construction misses as passes** and is a corpus-
  conformance metric, not retrieval quality. `surfacedRate` (59.1%) is closer to
  recall@k. Is the go-live retrieval bar `surfacedRate`/recall@k only, with
  `expectedMetRate` reported as a corpus check, or is `expectedMetRate` a bar in
  its own right? T10 proposes **both readings** until this is settled, so the
  proposal is not blocked.
- **OQ26 — Is stage 1 safe to schedule unattended? (new).** D13 schedules only
  stage 2 (Mongo-only) daily and leaves stage 1 manual, but stage 1 *could* join
  the schedule: it is a live aux LLM call per case (36 cases) and is not
  deterministic in the formal sense. Scheduling it adds daily provider cost and
  re-introduces the RPM/rate-limit risk (OQ11) that stage 3 is kept off the
  schedule to avoid. Should stage 1 join the schedule, or stay manual? Also: if
  the T9 double-run disagrees, does that block ratification? Ties to OQ6/OQ11.
- **OQ27 — Do memory rows pollute the tool-use admin counts? (new, confirmation
  only).** `countScores` is not kind-filtered, so a `kind:'memory'` run's sentinel
  `results` rows land in the same summary `counts`/`total` as tool-use runs. D9
  commits to the default (leave `countScores` unchanged; a `kind` badge
  disambiguates), so **T6/T7 proceed without waiting** — this OQ only asks the
  owner to confirm the default or request a kind-scoped summary as a follow-up.
- **OQ28 — Should the two eval suites share one reserved `evalUserId`? (new).**
  The tool-use suite and the memory suite both seed and clear the *same*
  reserved user, and each teardown deletes the other's fixtures
  (`clearMemoryCorpus` removes every `Asset`; `clearEvalSource` removes every
  `Asset` and the `User`). D19 makes this safe by running the suites strictly
  sequentially, and that is the default T8 implements, so no task depends on this
  question. The open part: is sequential sharing acceptable long-term, or should
  each suite get its own reserved user (removing the mutual-clobber footgun at
  the cost of a second fixture user)? If the latter, it is a small follow-up.
- **OQ29 — Stage-3 model identity and invalidation (corrected pass 5).** `metrics`
  currently records only the gate model and corpus hash, but a stage-3 baseline
  also depends on the responder model and the judge model. (The responder is the
  **`ROSTER_SEED` constant** `zai-org/GLM-5.3-Flash`, not the tool-use
  `TOVA_EVAL_*` env — the earlier claim of env coupling was false.) D15/T6 now
  *record* all three identities unconditionally, so no task depends on this; the
  open part is the policy: should a change in the responder or judge model (or the
  `ROSTER_SEED` fallback) invalidate a ratified helpfulness bar (extending OQ16
  from the gate to stage 3), and should T14c's dedicated override become the
  default so the arm no longer tracks a source constant?
- **OQ30 — Judge provider failure: record or abort? (new, pass 4).** `defaultJudge`
  currently lets a provider error propagate, aborting the whole stage-3 run
  (pass-4 defect 1). T14b's safe default is to catch it into a per-case `error`
  and continue, so the deterministic backbone still reports. Is "record and
  continue" right, or should a provider failure **abort** the run (a partial
  win-rate over a shrunken denominator is misleading), and how should the report
  flag a run where a large fraction of pairs errored? Ties to OQ20/OQ11.
- **OQ31 — LangSmith corpus push: idempotency and scores (new, pass 4).**
  `pushMemoryCorpusToLangSmith` appends one example per case on every run, so a
  re-run (T9 runs twice) duplicates the whole `tova-memory-evals` dataset, and no
  run/feedback links the local metrics to the dataset (unlike `pushToLangSmith`).
  Should the push be idempotent (clear/upsert by case id), and should the graded
  results be attached as runs + feedback so the dataset carries scores? Or is the
  dataset deliberately corpus-only, with the local run as the sole metric record?
- **OQ32 — Stage-3 provider rate-limit budget/policy (new, pass 4).** Stage 3
  makes ~2 responder + ~2 judge calls per judged scenario on `gpt-oss-120b`; a
  120b Groq tier may be tighter than the gate's 30 RPM, and a 429 aborts the run
  absent T14b. T15d paces stage 3 unconditionally; the open part is the budget
  (fixed delay vs provider-aware backoff) and whether a limited run should
  retry, skip, or fail the run. Ties to OQ6 (cost) and OQ11 (gate failures).
- **OQ33 — Gate timeout policy (new, pass 5).** The eval reads the gate through
  `enrichmentVotes`, which applies the *production* `ENRICHMENT_TIMEOUT_MS`
  (default 1500ms) and resolves a timeout to `{workspace:false}`. A
  slow-but-correct aux call is therefore scored a false negative, inflating the
  exact metric #289 exists to trust. Distinct from OQ11 (a provider error/429,
  which T15b's strict seam records as `failed`): a timeout is a latency failure
  that the strict `classifyFileIntent` seam does **not** bypass, so T15b must
  decide whether to (a) call the classifier directly with no timeout for the eval,
  (b) raise the cap for the eval, or (c) measure the production timeout as part of
  the gate and record a distinct `timeout` outcome. Ties to OQ11/OQ26.
- **OQ34 — Responder generation budget / truncation (new, pass 5).** The stage-3
  responder uses `max_tokens: 512` (`helpfulnessEval.ts:198`). A fact late in a
  long answer can be truncated, scoring a backbone miss for a generation-budget
  reason rather than a helpfulness one — the responder analogue of the judge
  budget (OQ21). Should T14f raise the responder budget (and is a raised budget
  still production-faithful), or is `512` the production value the eval should
  measure? T14f implements a safe default (raise + assert non-truncation)
  unconditionally, so no task depends on the answer.
- **OQ35 — Is the lease global or kind-scoped? (new, pass 5).** D14 (corrected)
  keeps `findRunning` **global** so the two suites can never overlap under the
  shared `evalUserId`, and kind-scopes only idempotency/reclaim. The alternative —
  kind-scope the lease too, allowing a manual memory run to overlap a scheduled
  tool-use run — is only safe if the suites get separate reserved users (OQ28).
  Confirm the global-lease default, or pair a kind-scoped lease with OQ28's
  per-suite users as one follow-up. T6/T8 implement the global default, so no task
  depends on this.
- **OQ36 — What distinguishes a bare-deictic refer-back from a bare-deictic
  fresh ask? (new, pass 6; supersedes OQ12's two-case framing.)** Five positives
  are bare-deictic with no history (`gate-same-as-before`, `gate-other-one`,
  `gate-and-that-one`, `gate-previous-version`, `gate-one-from-yesterday`). The
  old T1b would have added "and that one?" as a **negative** — the same input
  shape as the positive `gate-and-that-one` ("And that one as well?"), with the
  opposite label and no history in either. In the input the gate sees, bare deixis
  is genuinely ambiguous: "use the other one" *could* refer to a just-offered
  option (refer-back) or be a fresh ask. So either (a) the subtype is a refer-back
  and the gate is expected to fire on bare deixis (three of five already do), or
  (b) the subtype is unfair/unresolvable and all five should be dropped or
  relabelled — but the corpus cannot carry both a bare-deictic positive and a
  bare-deictic negative for the same shape. This blocks adding bare-deictic
  negatives (now Follow-ups, not a task) and blocks a clean per-subtype recall
  bar. Ties to OQ1/OQ12/OQ19. **No task depends on this**: T1b-i records the
  subtype only, and the negatives are not touched.
- **OQ37 — Do the two eval suites' *test* files need separate fixtures? (new,
  pass 7.)** D19/T8 sequence the suites at runtime, but the Jest run is a second
  concurrency surface: `evals/mongoSource.test.ts` (tool-use) and
  `evals/memory/memorySource.test.ts` / `helpfulnessEval.integration.test.ts`
  run in separate workers against one in-memory Mongo and the one shared
  `evalUserId`. `mongoSource.test.ts` asserts a *global*
  `Asset.countDocuments() === 4`, so a concurrent memory seed/clear can delete
  its fixtures mid-test. Not reproduced in 20 forced runs, but the shared mutable
  state is a latent flake. Options: give each suite its own reserved user (OQ28,
  the same follow-up), or serialise the conflicting files. D19 covers the
  scheduler, not the test run; no task depends on this (CI is green today).
- **OQ38 — Is the judge parser's last-token rule safe for a reasoning model?
  (new, pass 7.)** `parseJudgeVerdict` takes the *last* standalone `A|B|TIE`
  token, so a reply that names both arms — "A is better because B misses the
  point" — parses as `B`, inverting the verdict. This is distinct from OQ20
  (failure vs tie: the token here is present and parseable) and OQ21
  (truncation): the selection position is wrong. Should the parser prefer a
  token that is the entire final line (the prompt says "reply with ONLY one
  token"), or the first token, or should the preflight (T14d) assert the shape
  instead? No task depends on this until the judge is trusted.
- **OQ39 — Gate-eval history fidelity (new, pass 8).** The live chat path caps
  the history handed to `enrichmentVotes` at **10 persisted messages**
  (`chat.ts:825-827`, `.sort({timestamp:-1}).limit(10)`, then
  `enrichmentHistoryFromDocs` drops the current turn and reverses → at most 9
  prior messages), while `runGateEval` passes each case's `history` **verbatim**
  (`memoryEvalService.ts:184`). A `continuation` positive whose referent sits more
  than ~9 messages back would fire in the eval but not live, so the eval would
  overstate recall for that shape. Today's cases have 1–2 turn histories, so it
  does not bite; but the corpus has no invariant pinning history length to the
  live window. Should the corpus constrain `history` to ≤ the live window (and add
  a test), or should the eval deliberately measure an unbounded history (and
  document the divergence)? Ties to OQ23 (assembly fidelity). No task depends on
  the answer — T1b-i records subtype, not history length.
- **OQ40 — Is the precision bar measured at the right prevalence? (new, pass 8.)**
  The gate set is **18 pos / 18 neg** — a 50% positive rate **by construction**.
  Precision depends on prevalence: a gate that fires on most pronoun-bearing turns
  can post high precision at 50% positives yet be near-useless at the live
  prevalence, which is far lower (the T11 dev vote rate is the only live estimate,
  and even that is over ad-hoc turns). The ticket's ship target is "precision
  ~70–80%", but does that mean precision *at the corpus's 50% rate* or *at the live
  base rate*? Should T10 add a prevalence-adjusted precision line (reweight the
  confusion matrix by T11's observed dev vote rate), or is the corpus number the
  intended bar? Distinct from OQ19 (negative-set strength) and OQ25 (which
  retrieval number); ties to OQ1/OQ26. No task depends on the answer — T10
  proposes the corpus-prevalence bar and can add the adjusted line either way.
- **OQ41 — Is the branch stale relative to #293, voiding the recorded baseline and
  the `out-of-pool` corpus expectation? (new, critic pass 8.)** This branch is
  based on `5a9ecfa` (PR #301) and does **not** contain #293; `origin/main` is now
  `80492cd` (PR #302, "#293 workspace retrieval"). #293 dropped the bounded
  `MESSAGE_POOL` message read for a **whole-corpus BM25** ranker and, on `main`,
  flipped the `out-of-pool` scenario to `expectSurfaced: true` (it is now
  reachable — the whole point of #293). The branch therefore:
  - records a **pre-#293** retrieval baseline (`expectedMet 77.3% / surfacedRate
    59.1%`, `out-of-pool 0/2`) that no longer describes the code that will run on
    `main`;
  - keeps `retrieval-out-of-pool` (and the second `retrieval-out-of-pool-wheel`)
    at `expectSurfaced: false`, and hard-codes `out-of-pool` as a by-construction
    miss in the `corpus.test.ts` "marks expectSurfaced consistently" invariant.

  A dry-run merge (`git merge-tree --write-tree origin/main HEAD`) reports **no
  textual conflict**, but the merged tree is semantically inconsistent: it keeps
  `main`'s first `out-of-pool` `expectSurfaced: true` next to the branch's
  invariant requiring every `out-of-pool` case to be `false`, so the merged
  tree's `corpus.test.ts` **fails**; the branch's second `out-of-pool` case would
  also surface under #293's whole-corpus read, so its `false` is wrong too.
  The ticket/plan premise "#293 will move stage 2" is already stale — #293 has
  moved it. **Question:** must the branch be rebased onto `origin/main` before
  T9, with the `out-of-pool` expectations flipped to `true` and the retrieval
  baseline re-captured against BM25? Is the recorded pre-#293 baseline (and the
  `out-of-pool` "RAG headroom" framing) void? Affects T2/T9/T10 and the plan's
  whole "retrieval misses are by design" claim. No code task in T3–T8 depends on
  the answer, but T9 cannot capture a valid baseline until it is settled.
  (Also: the `paraphrase` category should stay a miss under BM25 — no shared
  terms — but that is an assumption T9 must confirm post-rebase, not a given.)

## Follow-ups (not in this plan)

- #293 (BM25/keyword retrieval) and #294 (embeddings/vector) — the retrieval
  improvements stage 2 measures; expect recall@k to move first, with the
  precision tradeoff and helpfulness lag reported per the decisions.
- Widening retrieval to assistant turns, **if** T12 decides that way.
- Revisiting `MESSAGE_POOL` (and the other pool caps) if the out-of-pool
  evidence demands it.
- Scheduling stage 3, **if** OQ6 is answered in favour.
- Scheduling stage 1, **if** OQ26 is answered in favour (vs stage 2 only).
- Per-subtype gate bars, **if** OQ12 is judged to need them (T1b-i records the
  subtype regardless).
- Bare-deictic fresh-ask negatives, **if** OQ36 rules that bare deixis is a
  fresh-ask shape (they are omitted now because they collide with the
  bare-deictic positive `gate-and-that-one`).
- A separate reserved `evalUserId` per suite, **if** OQ28 asks for it; this is the
  prerequisite for allowing cross-kind concurrency, which is **OQ35**.
- A stage-3 responder roster sweep, **if** OQ24 asks for one.
- A kind-scoped admin summary, **if** OQ27 rejects the D9 default.
- An eval gate seam that bypasses the production `ENRICHMENT_TIMEOUT_MS`, **if**
  OQ33 chooses that over recording the timeout distinctly.
- Constraining gate-case `history` to the live 10-message window (with a corpus
  invariant), **if** OQ39 asks for fidelity over an unbounded history.
- A prevalence-adjusted precision line in the T10 table (reweighted by T11's dev
  vote rate), **if** OQ40 says the bar must be at the live base rate.

## Done

- [x] T0 promote this plan + pointer + stale-sentence fix in the repo doc.
  Delivered: this file now lives at `docs/plan-289-workspace-memory.md` (copied
  from `.iteration/`), `docs/plan-289-gate-evals.md` carries a pointer under its
  H1 and defers its Follow-ups here; the stale Decision-1 sentence and the OQ12
  framing were already corrected by pass 7, and the baseline carries a
  provenance caveat naming T9 as the re-capture.
- [x] T1 grow the hand-labelled gate set (n=36, 18/18; note-provenance and
  duplicate-prompt invariants added; baseline re-captured)
- [x] T1b-i record refer-back subtypes (negatives not touched; see OQ36).
  Delivered: `GateSubtype` on `GateCase` + every positive (explicit 9,
  bare-deixis 5, continuation 4); `recallBySubtype` on `GateMetrics`; CLI prints
  the breakdown; corpus invariants (subtype on every positive/none on negatives,
  pinned counts, bare-deixis history-free, continuation history-bearing).
  Observed run (local stack, 2026-10-14): gate precision 100% / recall 88.9% /
  fireRate 44.4% (n=36) — explicit 100% (9/9), bare-deixis 80% (4/5),
  continuation 75% (3/4). Misses: `gate-one-from-yesterday` (bare-deixis),
  `gate-finish-draft` (continuation); `gate-other-one` passed this run (run-to-run
  variance, OQ26). The corpus hash changes (D15), so T9 re-captures the baseline.
- [x] T2 grow the retrieval/helpfulness scenarios (n=22; per-category minimum-N,
  every-paraphrase no-overlap, expected-fact-in-seed invariants)
- [x] T3 stage-3 deterministic backbone (`runHelpfulnessEval`, both arms,
  counterfactual, id assertion)
- [x] T4 pairwise blinded, position-swapped judge (`resolveSwappedOutcome`,
  `parseJudgeVerdict`, `config.memoryEval` judge id)
- [x] T14a `normaliseFact` (casefold + whitespace-collapse). Delivered:
  `normaliseFact` + `containsFact` routed through it; unit tests for a
  newline/double-space-split fact and a genuinely absent fact.
- [x] T14b judge `error` outcome distinct from `tie`. Delivered: `JudgeVerdict`/
  `PairOutcome` gain `error`; `parseJudgeVerdict` returns `error` for an
  empty/unparseable reply; `resolveSwappedOutcome` returns `error` if either
  presentation errored; a thrown judge call is caught per pair into `error`
  (record-and-continue, the OQ30 default); `helpfulnessMetrics.errors` is
  separate from `ties` and excluded from the win-rate denominator.
- [x] T14c configurable responder. Delivered: `config.memoryEval.responderModel`/
  `responderProvider` (undefined → roster fallback) / `responderTemperature`;
  `defaultRespond` reads them.
- [x] T14d live judge preflight. Delivered: `runJudgePreflight` + `--preflight-judge`.
  Live run **caught a real defect**: `gpt-oss-120b` at the old `max_tokens: 16`
  returned an empty completion (reasoning truncated before the verdict), so both
  orders parsed `error`. Raised to `JUDGE_MAX_TOKENS = 512`; preflight now reads
  `first=A second=B`. This confirmed **and closed** OQ21 (now a decision, D2).
- [x] T14e exception-safe fixture cleanup (`try/finally { clear() }`). Delivered
  in both `runHelpfulnessEval` and `runRetrievalEval`; unit tests assert `clear`
  runs on the way out when the responder/retrieve throws.
- [ ] T14f responder generation-budget guard (raise `max_tokens`, flag truncation).
  **Open, with a named blocker:** `NeutralCompletion` (`llmTypes.ts:100`) carries
  no `finish_reason`, so flagging truncation needs connector plumbing (see the
  task for the split-into-follow-up option); deferred to its own pass.
- [x] T15a enrichment precondition for the gate stage. Delivered:
  `assertEnrichmentEnabled()` in `memoryEvalService.ts` (reads `isEnrichmentEnabled`),
  called at the top of `runGateEval`; throws a clear `ENRICHMENT_ENABLED` message
  rather than posting a 0% gate. Tests for off/on/unset.
- [x] T15b gate provider-failure distinctness. Delivered: `classifyFileIntentStrict`
  (rethrows) + `classifyFileIntentForEval` returning an `EnrichmentProbe`
  (`ok`/`timeout`/`error`) under the production `ENRICHMENT_TIMEOUT_MS` cap;
  `runGateEval` records `failed`/`timeout` per case; `gateMetrics` gains `errors`,
  `timeouts` and `evaluated`, all excluded from the confusion matrix so a 429 or a
  timeout is never a silent false negative. CLI prints `ERR`/`TMO`.
- [x] T15c gate pacing / retry. Delivered: injectable `pace` seam on `runGateEval`,
  `defaultGatePace` reading the new `config.memoryEval.gatePaceMs`
  (`MEMORY_EVAL_GATE_PACE_MS`, default 2000ms); pace-only, no retry (a 429 is still
  recorded as `failed`, not masked).
- [x] T15d stage-3 responder/judge pacing. Delivered: injectable `pace` seam,
  `defaultPace` reading `config.memoryEval.paceMs` (default 1000ms), called before
  every live responder/judge call; tests inject a no-op.
- [x] T5 judge validation harness (+ constructed seed; the "trusted" line is
  owner-gated on OQ1, the harness itself is not). Delivered:
  `evals/memory/judgeValidation.ts` (`JudgeLabel`/`JudgeAgreement`,
  `constructedJudgeLabels` with alternating arms, `handJudgeLabels` covering
  all three classes with `agent-authored` provenance, `judgeAgreement` →
  `{ n, errors, accuracy, kappa, confusion }` with Cohen's kappa and
  absent-class null); `defaultJudge` exported; a thrown judge call is caught
  per pair into `error` (T14b/OQ30) and calls are paced by the new config-sourced
  `config.memoryEval.judgePaceMs` (`MEMORY_EVAL_JUDGE_PACE_MS`, default 2000ms,
  T5) so a live `--validate-judge` run degrades rather than aborting; `scripts/run-memory-evals.ts
  --validate-judge` prints both sets with provenance (constructed labelled
  "smoke test only, not evidence"); `judgeValidation.test.ts` pins the arithmetic.
  No owner input needed; the live run is recorded below.
  - **Live `--validate-judge` (2026-10-14, Groq):** constructed n=22, errors=0,
    accuracy **63.6%** (14/22), kappa n/a (the tie class is absent by
    construction); hand-labelled n=15, errors=0, accuracy **100%**, kappa
    **1.000**. A raw-completion probe confirms the parser is not the cause (the
    completions are clean single tokens): the judge *consistently* prefers the
    fluent refusal ("I don't have any information about that.") over a terse
    fact fragment ("Here is what I found: paediatrician.") on ~1/3 of the
    constructed pairs, regardless of position. Two consequences, both recorded:
    (a) the constructed set's premise — "fact-bearing ⇒ more helpful" — is not
    what a holistic helpfulness judge sees, so its accuracy is a **lower bound on
    judge/backbone divergence**, not a defect in the harness (and it is evidence
    the judge does *not* merely echo the substring rule — OQ17); (b) a stage-3
    with-arm answer that is terse can be rated *less* helpful than a refusal even
    when it carries the fact, so the win-rate can be depressed by terseness — a
    caveat for the T10 stage-3 bar. The hand-labelled seed is the primary
    number and is `agent-authored` (OQ1); it is not independent evidence.
  - **Pacing finding (OQ32).** The first live run used the stage-3 1000ms pace and
    tripped Groq's 30 RPM on the 37-call judge burst (3 pairs errored). A
    dedicated `config.memoryEval.judgePaceMs` (`MEMORY_EVAL_JUDGE_PACE_MS`,
    default **2000ms**, matching the gate's headroom) removed the 429; the clean
    run above has `errors=0`. The stage-3 `paceMs` (1000ms) is left as-is: its
    responder calls are slow enough that its effective RPM stays under the cap.
- [ ] T6 persist memory metrics (server; incl. `kind`, `metrics`, migration,
  corpus hash, all three model identities)
- [ ] T7 surface metrics in the admin Evals tab (client)
- [ ] T8 wire memory stage 2 into the scheduled suite (sequential with tool-use)
- [ ] T9 enlarged baseline (all three stages, via `--helpfulness`, twice)
- [ ] T10 propose thresholds for all three stages (stage-3 bar provisional until
  the judge is validated)
- [ ] T11 manual LangSmith sanity check
- [ ] T12 decide the assistant-turns question
- [ ] T13a go/no-go recommendation for live (from the proposed T10 bars)
- [ ] T13b owner ratification + flag flip (owner action)
