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

Every main run is failing. Two independent causes:

1. **Security scans** — fixed today (commit `d621f25`, run
   [37123669001](https://github.com/alex-moon/tova/actions/runs/37123669001)):
   `gitleaks`, `semgrep`, `npm-audit`, `osv-scanner` all **green**.
2. **`ci` server tests — still red, pre-existing.** The `ci` job fails on
   flaky/interfering server tests that also fail on `main` before any of this
   week's work (e.g. run `37065093274`): `chat.test.ts` / `chat.stream.test.ts`
   "per-user system prompt (#35)" and follow-up-suggestions, and
   `modelConfigService.test.ts` "capabilities (#94)". They pass locally but
   fail under CI timing. Root cause is the test harness: each suite spins up
   its own `MongoMemoryServer` in `beforeAll`, and `--runInBand` shares one
   mongoose connection across suites, so suites interfere (read-after-write
   staleness). **#181's branch already fixes exactly this** (see below).

**Recommendation:** land **#181** first. It is the unblocker for the merge gate
and for #195/#196/#199, all of which currently cannot be observed green.

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

### #199 — Model pricing · branch `feat/199-model-pricing` (PR #206, open, not draft)

**Status: implementation complete; two open questions already answered by you
("Proposals accepted. Fix tests."), plus a CI/evidence gate.**

All three requirements are implemented and reviewed: admin price columns + cap
badge, `rowWithinPriceCap` hard cap in `listByTier`, and price-weighted selection
in `pickModelRef`. The owner accepted the migration `$set` and env-cap proposals.

Remaining:

- Fix the server tests on the branch (you instructed this) — entangled with
  Blocker #0; #181 first.
- Per the repo's own **evidence-first routing policy** (AGENTS.md "Model routing
  decisions"), the price-weighting distribution should get a LangSmith/eval
  pass before it's treated as final — I can do that.
- A live Playwright check of the admin price table was never run; I can do it.

The only genuine product judgement (does the cap retire 7 seeded models and
shrink the vision pool 10→7?) was already surfaced and accepted in the thread.
I can land this after #181.

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
   **Done this pass:** ~29s suite, flake stable 5/5, PR #204 green.
2. **#199** — branch is complete; fix tests, run the routing-evidence pass,
   Playwright the admin table, ship.
3. **#196** — make the presentation calls, add the missing client half, ship.
4. **#197** — I make the scope call, split the tickets, implement the core.
5. **#195** — needs your two answers + repro before it leaves draft.
6. **#179**, **#166** — need owner decisions; #166 also welcomes a proposal
   from me to react to.

## Quick scoreboard

| Ticket | Branch/PR                                   | Bucket  | Next action                                  |
| ------ | ------------------------------------------- | ------- | -------------------------------------------- |
| #181   | `feat/181-speed-up` / #204                  | ✅ DONE | shipped; PR green, ready for review          |
| #196   | `feat/196-tool-ux`                          | (b)     | make presentation calls, finish client, ship |
| #197   | —                                           | (b)     | decide view + split, implement core          |
| #199   | `feat/199-model-pricing` / #206             | (b)     | fix tests, evidence pass, Playwright, ship   |
| #195   | `feat/195-confirm-completed` / #205 (draft) | (c)     | your 2 answers + repro                       |
| #179   | —                                           | (c)     | your infra topology call                     |
| #166   | —                                           | (c)     | your mechanism call (I can propose)          |
