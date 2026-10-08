# Plan — Ticket roster and merge strategy

## Base-branch plan (owner decision, 2026-10-08)

- The new **base branch is `epic/roster`**. All work in this roster targets
  `epic/roster`, not `main`.
- **`epic/roster` merges into `main` only once every ticket below is done.**
- This doc is the live roster and the place where new-work sequencing is
  tracked. `AGENTS.md`/`docs/workflow.md` keep their general process; the
  base-branch exception lives here.
- **Stable points** (a coherent, shippable subset of the epic) are recorded
  inline in the "Stable points" section as they are reached, so the epic can be
  checkpointed without merging to `main` prematurely.

`epic/roster` is currently identical to `main` (`git rev-list --count` is 0 in
both directions), so the branch is a clean base.

## Working rules on `epic/roster`

- **Checkout `epic/roster` before starting work, and check it out again after
  finishing.** Do not do roster work on `main` or any other branch.
- **Commit and push all work.** Nothing is considered done until it is committed
  and pushed to `epic/roster`.
- **Keep this doc (`docs/plan-roster.md`) updated on `epic/roster` and pushed.**
  The roster, stable points, and checklist live here; they must reflect the
  pushed state of the branch, not just the working tree.

## Scope

Nine open issues on `alex-moon/tova`:

| # | Title | Bucket |
|---|-------|--------|
| 232 | Replace smart routing with a fixed model roster + hedged provider racing | Epic |
| 233 | Delete dead code from the tier-era router | Do-able |
| 234 | Admin: rework Models and Compare tabs for the fixed roster | Do-able (after 232) |
| 235 | Cost tracking: price per (model, provider) under racing | Do-able (after 232) |
| 236 | Evals: sweep the fixed roster, not the tier seed universe | Do-able (after 232) |
| 237 | LangSmith: provider attribution and TTFT under racing | Do-able (after 232) |
| 238 | Aux calls + enrichment pass after the guard classifier retires | Do-able (after 232) |
| 214 | Decide whether/how to reference an existing file for the next turn | Blocked on owner |
| 166 | Offline worker | Blocked on owner |

## Triage

Bucket definitions:

- **Do-able** — no open decision blocks implementation; can be built and
  verified in-repo today (sequencing constraints noted).
- **Blocked on owner** — a product/scope/topology decision only the owner can
  make; implementation cannot start without it.

### Do-able

The whole #232 epic (232–238) is do-able. #232's *design* questions have been
resolved by the owner (roster locked at three dual-serverless models, MiniMax M3
treated as text-only, weighted score = `f(TTFT) × price penalty`); what remains
is implementation. Grounding facts verified in-repo:

- No Fireworks connector exists yet (`rg -i fireworks src/` returns nothing; no
  `FIREWORKS_*` in `.env.example`) — the connector is net-new work in #232.
- The tier machinery is real and large: `routerService.ts` (559 lines),
  `modelConfigService.ts` (666), `modelFailover.ts` (121); env reads in
  `config/index.ts:98–107`.
- The children are genuine workstreams of #232, not speculative: each cites
  file:line evidence from a full codebase sweep.

Sequencing: #232 must settle its data-model shape (nested `providers[]` vs flat
rows) before #234 and #235 can start; #233 (big-bang vs phased deletion) and
#236/#237/#238 all hang off #232.

### Blocked on owner

- **#214** — the issue is explicitly decision-only. Its own scope says
  implementation is pending owner direction, and it lists open questions that
  are the owner's call (is retrieval unreliable or is it trust perception; where
  a reference affordance should live; whether to invest in retrieval
  legibility instead). The ticket's triage analysis leans D (make retrieval
  legible) but will not pick the mechanism without owner input.
- **#166** — the ticket text itself reserves the mechanism decision for the
  owner: *"Propose a mechanism for this two-way communication link before
  implementing. Put it in the comments."* The thread is empty. I can draft a
  proposal for the owner to react to, but cannot implement unilaterally.

## Suggested order

Ordered by readiness and dependency. The epic is the bulk of the work; the two
owner-blocked tickets can progress in parallel via proposals/decisions where the
owner is available.

1. **#232** — add the Fireworks connector, the roster data model, the weighted
   score, the racing runtime, and roster fallback. Foundation; unblocks every
   child. Do this first.
2. **#233** — dead-code purge. Sequence the deletion after #232's new path is
   in place (aggressive big-bang deletion before the replacement exists is the
   high-blast-radius option; prefer building alongside then deleting).
3. **#234** — admin Models + Compare tabs for the roster (needs #232 data model).
4. **#235** — cost tracking per (model, provider) (needs #232 data model).
5. **#237** — LangSmith provider attribution + TTFT (needs #232 runtime).
6. **#238** — aux calls + enrichment pass (needs #232 guard removal).
7. **#236** — evals sweep the roster (needs #232 roster; lowest coupling).
8. **#214** — produce a decision record for the owner; only implement once the
   mechanism is chosen. Can run in parallel.
9. **#166** — write and post a mechanism proposal for the owner; implement only
   after approval. Can run in parallel.

Rationale for the #233 position: the deletion ticket's own OQ3 flags that
big-bang removal is high blast radius; landing #232 first (optionally with the
old router coexisting briefly) makes the purge mechanical rather than risky.

## Stable points

Recorded as coherent, independently shippable checkpoints within the epic. They
do not trigger a merge to `main`; they are safe points to pause, review, or
demo on `epic/roster`.

- **SP0 — Foundation (after #232).** Fixed roster + provider racing runs behind
  the existing app; no deletions yet. The app is functionally complete and
  verifiable even though the old tier code still exists.
  **Reached (2026-10-08).** `fireworks` connector, `ModelRoster` collection +
  migration, weighted pick (`score = TTFT × price penalty`), hedged racing with
  loser abort, roster fallback, and both chat routes wired. Racing is gated by
  `ROSTER_RACING_ENABLED` (default on outside tests) and falls back to the tier
  router when off/empty. `npm run ci` green (91 suites, 1196 tests). Tier
  machinery intentionally still present — deletion is #233.

## Done (checklist)

- [x] Enumerate open issues and triage for do-ability.
- [x] Record the `epic/roster` base-branch plan.
- [x] Delete the stale `docs/tickets-261003.md` snapshot.
- [x] #232 completed on `epic/roster` (SP0 reached; CI green).
- [ ] #233–#238 completed on `epic/roster`.
- [ ] #214 and #166 resolved (decision/proposal at minimum).
- [ ] `epic/roster` merged to `main`.

## Follow-ups

- #214 and #166 need owner input (mechanism/decision) before implementation.
