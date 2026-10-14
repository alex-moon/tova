# Plan — #306 Workspace memory evals: closeout and live-flag ratification

Issue: [alex-moon/tova#306](https://github.com/alex-moon/tova/issues/306). Epic: #251.
Follow-up to #289 — the decision record and all rationale live in the archived
[plan-289-workspace-memory.md](./done/plan-289-workspace-memory.md) and
[plan-289-gate-evals.md](./done/plan-289-gate-evals.md); this doc carries only
the forward checklist and does not re-litigate settled decisions.

## Motivation

#289 delivered the full memory eval harness (deterministic gate + retrieval
stages, stage-3 pairwise judge re-pinned to `Qwen/Qwen3-235B-A22B-Instruct-2507`
on deepinfra, metrics persistence, the T9 enlarged baseline, the T10 threshold
proposal, and the T13a **GO** recommendation). Four items remain open, tracked
in #306: making the persisted metrics visible, the live-path sanity check, one
corpus decision, and the owner's ratification + flag flip. `WORKSPACE_MEMORY_ENABLED`
stays off until T13b closes.

## Decisions

Inherited from #289 (recorded there; listed here only as operating constraints):

1. **Manual-only scheduling** (owner batch-2): the whole memory suite stays off
   the unattended scheduler; **T8 is descoped**. T7's admin render is what keeps
   manual runs discoverable.
2. **Judge**: `Qwen/Qwen3-235B-A22B-Instruct-2507` (deepinfra), 100%/100% on the
   validation sets; config-sourced, so any re-pin is a config change.
3. **Bare deixis is a product rule**: the gate stays quiet when the referent is
   not resolvable from visible history; the five no-history positives are
   relabelled negatives (landed pre-T9).
4. **Staleness**: a change in any recorded model identity voids the affected
   baseline until re-run (owner-approved policy).
5. Paraphrase retrieval headroom is **gated on #294's live Atlas measurement**,
   not on this ticket; rerank-and-cut is #305.

New decisions made under this ticket will be recorded here as they are made.

## Done

- [ ] **T7 — surface memory metrics in the admin Evals tab (client).** For
      `kind:'memory'` runs render the continuous rollup (gate
      precision/recall/fire-rate, retrieval recall@k, helpfulness win-rate,
      each with `n`, plus error/tie/truncated counts) in the run detail;
      `metrics` stays detail-only so the list query stays light; `kind` badge
      on the list row. Mobile-first; verify at ~375px with the `playwright-cli`
      skill (no horizontal overflow). Client tests mock the service. Verify:
      `npm run ci:client` then `npm run ci`.
- [ ] **T11 — manual LangSmith sanity check (no code).** On the local stack with
      `WORKSPACE_MEMORY_ENABLED=1` (restart the dev server), drive the real
      pattern — seed a fact in a long-lived chat, probe from a fresh one — then
      read the `tova-dev` traces: gate vote rate per turn, injected-block
      quality (right fact? noisy? stale?), and the eval judge/respond traces.
      Record explicitly that the dev vote rate is over ad-hoc turns while the
      eval fire-rate is over the 50%-positive corpus — a smell test, not an
      equality. Flag any turn where the live block is wrong (the eval's
      precision cannot see a bad-but-fact-carrying block). Deliverable: the
      finding appended here and posted on #306.
- [ ] **T12 — decide the assistant-turns corpus question (no code).** From the
      T9 per-category numbers: does any `expectedFact` live **only** in an
      assistant `Message` turn (today `collectWorkspaceSlices` indexes
      `role:'user'` messages only; task artifacts are unaffected — `seedTask`
      puts the fact in a `TaskEvent` the task slice reads in full)? Scan
      `MEMORY_SCENARIOS`; if none exists the as-is decision is evidence-backed;
      if one does (or the owner wants a probe), widening is a **new follow-up
      ticket** (it touches `collectWorkspaceSlices` and pool/cap logic), not a
      change here. Record the decision + rationale here and on #306.
- [ ] **T13b — owner ratification + flag flip (owner action).** The owner
      ratifies (or amends) the T10 bars — gate precision ≥ 70% + recall ≥ 85% +
      explicit-subtype ≥ 90% at corpus prevalence (OQ40); retrieval
      surfacedRate ≥ 65%; helpfulness win-rate ≥ 60% with ties 0.5 / errors
      excluded (OQ3/OQ20) — and makes the go/no-go call. If GO: flip
      `WORKSPACE_MEMORY_ENABLED=1`, record the ratified table + decision here
      and on #306. Kill switch: blank the var (or `0`) + container restart.
      Caveats carried into ratification (from T13a): corpus-prevalence
      precision; paraphrase unmeasured until #294 meets Atlas; manual-only
      scheduling.
- [ ] **Atlas vector index + embeddings backfill (prerequisite for the vector
      stage, verified missing 2026-10-14).** `listSearchIndexes()` on the live
      `workspace_embeddings` is empty — `workspace_embeddings_vector` was never
      created — so `vectorCandidates` degrades to `[]` and live retrieval is
      BM25-only regardless of the flag. Create it (`npm run db:vector-index`, or
      the Atlas UI: vector path `vector`, 768 dims, cosine; filters `model` +
      `userId`), then `npm run db:backfill-embeddings` (the collection holds
      only the dim-768 probe row). Re-run the stage-2 baseline after, so the
      paraphrase headroom is measured against a live index. Local stacks cannot
      have search indexes (Atlas-only) — expected.

## Follow-ups

- Widening retrieval to assistant turns, **if** T12 decides that way (new ticket).
- Scheduling any part of the memory suite, **if** revisited post-ratification
  (the T8 descope).
- Paraphrase retrieval measurement once #294 has a live Atlas index (may simply
  be a T9-style re-run + baseline update).
- Rerank-and-cut retrieval stage — #305, independent of this ticket.
