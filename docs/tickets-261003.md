# Outstanding tickets — readiness report (2026-10-03)

Scope: the 7 open issues on `alex-moon/tova`, plus their in-flight branches/PRs.
Grouped by what is needed to move each one:

- **(a) Ready to go** — no open decision; can be implemented today.
- **(b) Blocked on a call I can make** — an architectural decision, but with
  enough repo evidence that I can choose confidently and proceed.
- **(c) Blocked on you** — a decision only the owner can make (product intent,
  scope, or a mechanism the ticket explicitly reserves for you).

A cross-cutting blocker applies to everything below: see "Blocker #0" first.

---

## Blocker #0 — `main` CI is red (blocks every merge)

**Status: RESOLVED.** Both causes fixed and `main` is green again.

1. **Security scans** — fixed (commit `d621f25`, run
   [37123669001](https://github.com/alex-moon/tova/actions/runs/37123669001)):
   `gitleaks`, `semgrep`, `npm-audit`, `osv-scanner` all **green**.
2. **`ci` server tests — fixed by #181 (PR #204, merged).** The flaky/interfering
   server tests (`chat.test.ts` / `chat.stream.test.ts` "per-user system prompt
   (#35)", follow-up-suggestions, `modelConfigService.test.ts` "capabilities
   (#94)") were a test-harness artefact: each suite spun up its own
   `MongoMemoryServer` and `--runInBand` shared one mongoose connection, so
   suites interfered. #181 replaces this with one shared mongod
   (`globalSetup`/`globalTeardown`), per-worker DBs, and dropped `--runInBand`.
   `main` CI is green since #204 merged.

---

## (a) Ready to go today

### #181 — Speed up tests · branch `feat/181-speed-up` (PR #204, open, NOT draft)

**Status: DONE — shipped this pass (PR #204 green, out of draft).**

The branch replaces per-suite `MongoMemoryServer.create()` with one shared
instance via `globalSetup` + a per-worker/suite database name, and drops
`--runInBand` so Jest can parallelise (`jest.config.js`, `src/server/test/setup.ts`,
`src/server/test/globalSetup.ts`, `package.json`). This is the same mechanism
that should fix the `#0` flakiness.

Completed this pass:

- Deleted throwaway `scripts/tmp-probe-mms.ts`.
- Fixed the two defects in the draft: `globalTeardown` now lives in its own
  `globalTeardown.ts` (Jest silently ignores a named teardown export alongside a
  default `globalSetup`, which was leaking a `mongod` every run). Bonus: the
  `globalThis` handoff between the separate hook files **does** work in this Jest
  version — verified empirically, so no state-file machinery was needed.
- Enabled ts-jest `isolatedModules` (type-free transform); `npm run typecheck`
  remains the separate type gate.
- **Target met:** `npm test` **~29–34s cold, ~29s warm** (was ~60–90s).
- Flake hardening confirmed: the intermittently flaky suites
  (`chat.test.ts`, `chat.stream.test.ts`, `modelConfigService.test.ts`) passed
  **5/5** runs; full suite **3/3** green.
- `npm run ci` exits 0; no surviving test `mongod` (`pgrep -fl mongod`).
- PR #204 marked ready for review; CI green.

---

## (b) Blocked on a call I can make confidently

### #196 — Tool UX · branch `feat/196-tool-ux` (no PR yet)

**Status: implementation started, decision implicitly made by the branch.**

The ticket bundles four UX fixes and explicitly asks for a proposed solution to
the "expand arrow shows only `1 results`" item and to the "tool use summary"
box, then implement. The branch already implements the server half: tool calls
persisted on `Message` (`src/server/models/Message.ts`), chat route emits/
replays them, tests added. The remaining calls are presentational (where the
summary box lives, what the expanded chip shows) and the ticket itself says _any
defensible proposal_ is acceptable — so I can decide these confidently from the
existing admin/chat design language.

⚠️ **Gap:** the branch has **no client changes** (no `.tsx` diff), so "chips
disappear on refresh" and the summary box are untouched client-side. This is a
half-delivery; the visible symptoms live in the client.

I can take this and finish it today once #181 unblocks the gate.

### #197 — In-app asset viewer · no branch

**Status: blocked on a scope/architecture question — but it is mine to call.**

Two decisions are open (triage flagged them as owner-only): (a) keep the
Markdown preview in the existing assets modal vs. move assets to a separate
URL-backed view; (b) whether to split image preview + OCR into new tickets.

I can make both confidently:

- **(a) Separate view.** The ticket's own gut leans that way, it mirrors the
  existing profile/admin pattern, and previews need real estate a modal can't
  give. This is a reversible routing choice, not a data-model one.
- **(b) Split.** Image preview depends on thumbnailing (not built), and OCR is
  its own ingest concern — file them as separate tickets and trim #197 to the
  Markdown/text preview core, as the ticket invites.

I can create the split tickets, update #197, and implement the core today.

### #199 — Model pricing · branch `feat/199-model-pricing` (PR #206, **MERGED**)

**Status: DONE — merged to `main` (PR #206, commit `c199f60`).**

All three requirements shipped: admin price columns + cap badge,
`rowWithinPriceCap` hard cap in `listByTier`, and price-weighted selection in
`pickModelRef`. The missing `docs/plan-199-model-pricing.md` (the workflow
requires it in-repo; it had been living only in git-ignored `.iteration/docs/`)
was added on the branch this pass.

Completed this pass:

- **Tests fixed.** `npm run ci` exits 0 on the branch: 974 server / 208 client
  tests green; CI green on the branch's pre-merge HEAD. #181's harness landed on
  `main` as the permanent unblocker.
- **Evidence pass done** (AGENTS.md "Model routing decisions"), recorded in the
  plan doc: a LangSmith `tova-dev` trace read (100 traces; the large-tier draw is
  spread, guard model dominates) plus `scripts/eval-model-compare.ts` showing the
  in-cap `DeepSeek-V4.1-Flash` ($0.80/M) matches the over-cap `Kimi-K3`
  ($17.10/M) on quality. Cap blast radius measured against the live pool: no pool
  empties (large/text 4 survivors, large/vision 6, small/guard non-empty).
- **Playwright check done** against a live local stack: the Models table renders
  `In $/M` / `Out $/M` / `In+Out` columns, exactly **7** over-cap badges land on
  the 7 catalog-rule-out rows, and the edit form pre-fills the price inputs
  (`GLM-5.3-Flash` → `0.15`/`0.5`). Screenshots captured.

The product judgement (the cap retires 7 seeded rows and shrinks the vision pool
10→7) was surfaced and accepted; the measured counts confirm the pools stay
non-empty.

---

## (c) Blocked on a decision only you can make

### #195 — Confirm completed tool use · branch `feat/195-confirm-completed` (PR #205, **draft**)

**Status: code complete and verified in isolation; two owner calls outstanding
before it can leave draft.**

The implementation is sound (18/18 new tests, all three routes incl. ZDR). The
blockers are decisions, not code:

1. **Follow-up suggestions on synthesized confirmations.** Synthesizing
   "Created `file`." flips the empty-turn gate, so the server now makes an extra
   guard-model `generateFollowups` call per tool-only turn. Keep it (turn reads
   as complete) or skip suggestions when the content is synthesized? This is a
   cost/UX product call.
2. **Client test for the SSE delta.** Checklist item 5 ("verify by test") has
   no client streaming test; only server-contract tests. Acceptable, or do you
   want real client coverage?

Also still open from plan-review: **a reproducible example of the bug**. All four
`generate_file` traces in `tova-dev` end with real text, and the reported
`formatsatz@gmail.com` session isn't in the traces — so we can't tell whether
the user saw a real absence-of-text bug or nothing at all (which would be a
client issue this change wouldn't fix). A session id or screen recording would
close this.

I need your answers to (1) and (2), and ideally the repro.

### #179 — Persistent log retention across deploys (Loki + Promtail) · no branch

**Status: blocked on an infrastructure decision only you can make.**

The ticket names a direction (Promtail → Loki, admin-surfaced, multi-deploy
retention) but the real question is deployment topology: where Loki/Promtail
run, how they're provisioned alongside the app, retention/backup policy, and
whether the admin logs view queries Loki directly or via a new server endpoint.
Those depend on your hosting/budget posture and can't be inferred from the repo.
Once you pick the topology I can build it.

### #166 — Offline worker · no branch

**Status: blocked by ticket design — explicitly yours.**

The ticket says: _"Propose a mechanism for this two-way communication link
before implementing. Put it in the comments."_ The thread is empty. It reserves
the mechanism decision for you (task queue vs. message bus, how worker events
stream back into the chat, how steering works, which model/tier the worker
uses). I can draft a proposal for you to approve — but per the ticket I
shouldn't pick it unilaterally.

---

## Suggested order

1. ~~**#181** — finish + ship (cleanup, record timing, confirm the flake clears).~~
   **Done:** ~29s suite, flake stable 5/5, PR #204 **merged**.
2. ~~**#199** — branch is complete; fix tests, run the routing-evidence pass,
   Playwright the admin table, ship.~~ **Done:** PR #206 **merged**; plan doc
   added, evidence pass and Playwright check recorded.
3. **#196** — make the presentation calls, add the missing client half, ship.
4. **#197** — I make the scope call, split the tickets, implement the core.
5. **#195** — needs your two answers + repro before it leaves draft.
6. **#179**, **#166** — need owner decisions; #166 also welcomes a proposal
   from me to react to.

## Quick scoreboard

| Ticket | Branch/PR                                   | Bucket  | Next action                                  |
| ------ | ------------------------------------------- | ------- | -------------------------------------------- |
| #181   | `feat/181-speed-up` / #204                  | ✅ DONE | merged to `main`                             |
| #199   | `feat/199-model-pricing` / #206             | ✅ DONE | merged to `main` (`c199f60`)                 |
| #196   | `feat/196-tool-ux`                          | (b)     | make presentation calls, finish client, ship |
| #197   | —                                           | (b)     | decide view + split, implement core          |
| #195   | `feat/195-confirm-completed` / #205 (draft) | (c)     | your 2 answers + repro                       |
| #179   | —                                           | (c)     | your infra topology call                     |
| #166   | —                                           | (c)     | your mechanism call (I can propose)          |
