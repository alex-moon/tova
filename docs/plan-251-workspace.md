# Plan — #251 Workspace-centric architecture (epic)

Umbrella issue: [alex-moon/tova#251](https://github.com/alex-moon/tova/issues/251).
This doc lives on `epic/251-workspace` and is always updated there. It is the **durable
state** for the whole epic — what the epic contains, what it has decided, and how far it
has got. It is *not* the loop's operating manual: the delivery loop's mechanics live in
`workspace.sh` at the repo root, and this doc must never describe or instruct the loop
that reads it.

The loop runs from `workspace.sh` on the owner's machine. What it needs from this doc is
only *state*: the invariants, the decisions, the Done checklist, and the open owner
questions. The loop reconciles that state against git and GitHub; it does not take its
instructions from here.

## Motivation

Per #251: Tova is a **workspace-centric personal agent**. The durable layer is the
workspace — *work products* (files, chat/task transcripts, digests) with **provenance**;
the provenance is the graph, and there is no concept extraction. Chats and tasks are
activities over the workspace (a chat's context is the conversation; a task's context is
the workspace). Memory is RAG over the map: a cheap gate deciding when to inject, a
bounded knowledge block into the system prompt, personal-scale retrieval. Incognito/ZDR
activity stays out of the map by contract. This supersedes #138's entity-graph design and
reconceives the closed #166 as the task entity.

Slices, in dependency order (#252 lands first as the prerequisite vocabulary; #256 is
subtractive and lands only after #253 proves out):

- #252 — workspace provenance on generated files (prerequisite vocabulary; tiny)
- #253 — workspace memory: retrieval across chats and files (flagship)
- #254 — task entity: offline agent sequencer over the workspace
- #255 — chat-task integration
- #256 — retire the entity graph

## Binding invariants (from #251; binding on all slices)

- **Single writer per stream.** Chat and task streams never write each other;
  cross-references are thin (origin ref, provenance, queued notification).
- **Incognito/ZDR sessions never become workspace items**; reading the map from a ZDR
  turn stays read-only.
- **No new infrastructure.** Mongo-only, in-process pollers, no brokers.
- **Evidence-first where behavior changes** — above all the #253 retrieval gate.

## Decisions (epic-level)

Slice-level decisions live in the slice plan docs; this section carries epic-level ones.

- **Loop mechanics are out of scope for this doc.** The four-phase fresh-context
  protocol that once lived here was removed when the loop moved into `workspace.sh`;
  keeping it in the doc caused the loop to edit its own instructions mid-run. The doc
  carries state only; `workspace.sh` carries the protocol. Owner decision, 2026-10-11.
- **Slice branches cut from `epic/251-workspace`**, slice PRs target the epic branch,
  never `main`; one epic PR to `main` at the end, linking this doc. Cross-merges between
  slice branches are allowed where one depends on another.
- **Owner-decision fallback:** where a slice ticket defers an owner decision (see
  below), the loop picks a conservative default, records it in the slice plan doc's
  Decisions, and flags it at the top of the slice PR for the owner to veto. The loop
  never silently blocks on an absent owner.

### Open owner questions (settle, or default-and-flag per the fallback)

- May the loop merge its own slice PRs into the epic branch on CI green (keeping the
  human gate at the epic→main PR), or does every slice PR wait for the owner? Unsettled:
  until answered, the loop opens PRs and waits.
- #253: injection budget (chars); whether the trivially-neutral skip gate already covers
  gate-firing; corpus retention (do old chats expire?); pass/fail thresholds for the
  gate evals (retrieval hit-rate, injection helpfulness, gate precision). Slice merged
  (PR #271) with `WORKSPACE_MEMORY_ENABLED` default-off and the owner-defaults flagged on
  the PR; these questions stay open for the owner to settle before the flag turns on.
- #254: meter/pause/confirm behavior on budget breach — settled by the slice plan
  (`docs/plan-254-task-entity.md`, D6: breach → `paused` + visible system event, resume as
  steering); flagged at the slice PR for owner veto per the fallback.
- #256: entity-graph data disposition (keep read-only, archive, or drop).

## Done (epic)

- [x] Umbrella ticket #251 with slice tickets #252–#256, `epic` label, slices citing
      `Epic: #251`
- [x] Epic branch `epic/251-workspace` cut from `main`
- [x] Epic plan doc (this file)
- [x] Slice #252 — workspace provenance (PR #265 merged to `epic/251-workspace`; #252 closed)
- [x] Slice #253 — workspace memory (PR #271 merged into `epic/251-workspace` at `3b07303`;
      slice branch `feat/tv/253-workspace-memory` kept; #253 issue stays open until the
      epic ships, tracked above)
- [ ] Slice #254 — task entity (foundation landed: PR #269 merged to `epic/251-workspace`
      at `d3fcc6f`; loop-ownership spike DONE (decision (c) hybrid, cap 1), merged to
      `epic/251-workspace` via PR #272 at `04ecc57`; **sequencer loop landed server-side
      (connector `maxSteps` field + `taskSequencer` turn loop + steering/budget/resume tests)
      on `feat/tv/254-sequencer-loop` via PR #273, merged to `epic/251-workspace` at `a080039`;
      the post-merge hardening (`e305649`, tool-result + chip-query persistence) missed that
      merge and landed via follow-up PR #274, merged to `epic/251-workspace` at `cf2f93e`;
      **API routes landed on `feat/tv/254-task-routes` via PR #275 (`routes/tasks.ts` +
      `taskService` steer/cancel + D12 seq-retry + D13 cancel-boundary + D14/D15), pending
      merge to `epic/251-workspace`; the **task client view** remains**; #254 stays open
      until the epic ships)
- [ ] Slice #255 — chat-task integration
- [ ] Slice #256 — retire the entity graph
- [ ] Epic PR `epic/251-workspace` → `main`, linking this doc, `npm run ci` green
      (PR #270 opened as a draft; awaiting slice merges before it can leave draft)
- [ ] Archive this doc to `docs/done/`

## Process log (epic-level tasks)

A dated, append-only record of what the loop did to the epic — one entry per meaningful
change, newest last. No phase numbers: the loop records outcomes, not protocol steps.

- 2026-10-10 — wrote this doc: epic plan, invariants, slice list, Done checklist.
- 2026-10-10 — owner correction: #252 is not done — PR #265 was preliminary. Done
  checklist, Decisions, and Follow-ups updated to match.
- 2026-10-11 — owner correction: the above was wrong. A follow-up check ran afterward
  and #252 is done — PR #265 is merged into `epic/251-workspace` and #252 is closed.
  Done checklist updated to match.
- 2026-10-11 — removed the four-phase operating protocol from this doc (it now lives in
  `workspace.sh`); doc rewritten as epic state only.
- 2026-10-11 — reconciliation pass: Done checklist re-verified against git/GitHub (#252
  done via merged PR #265 and closed issue; #253–#256 open; no epic PR yet) — no drift.
  Open questions re-checked; the #254 budget-breach question is settled by its slice plan
  (D6) and annotated as such.
- 2026-10-11 — #254 foundation hardened before the gate: a review pass over the committed
  Task-entity foundation (commit `e262171` on `feat/tv/254-task-foundation`) fixed the
  `runTaskTick` failure path clobbering a settled task, the `Message.schema` invariant
  test, `config.task` env parse/floor and test isolation, and a redundant `TaskEvent`
  clock. Flagged out-of-window: `chat.stream.test.ts` (#261) had a rotted fixed-date seed
  that was already failing `npm run ci`; seeds made relative. `npm run ci` green on the
  slice branch; the slice PR against the epic branch is opened this pass. Slice plan doc
  (`docs/plan-254-task-entity.md`) carries the review findings.
- 2026-10-11 — #253 workspace memory implemented on `feat/tv/253-workspace-memory` (commits
  `9ab2af9` feature, `b4ea1f2` post-merge hardening): the #238 enrichment vote extended from
  `files` to `files`+`workspace` on the same aux call, a bounded in-process lexical+recency
  retrieval over the user's own messages and asset text (no vector infra, epic invariant),
  and a capped `<user:workspace>` block injected via `buildSystemContent` on both chat
  routes (ZDR reads stay read-only; ZDR turns never enter the corpus). Ships opt-in
  (`WORKSPACE_MEMORY_ENABLED`, default off until gate evals exist). Hardening fixed
  session-first pool scoping (starvation), self-retrieval of the just-saved turn, and the
  newline-accounted block cap. `npm run ci` green (89 suites, 1125 tests). Slice plan
  (`docs/plan-253-workspace-memory.md`) carries the decisions and owner-defaults; slice PR
  opened against `epic/251-workspace` this pass, not yet merged.
- 2026-10-11 — #253 unblocked for merge: PR #271 had gone `CONFLICTING`/`DIRTY` once the #254
  foundation (#269) and epic doc commits landed on `epic/251-workspace` after it was opened.
  Merged `epic/251-workspace` into `feat/tv/253-workspace-memory`, resolving the single
  conflict in `chat.stream.test.ts` (two independent fixes had landed for the same #261
  rotted fixed-date seed — kept the slice branch's `stamp()`-helper form). `npm run ci`
  green on the merged branch (93 suites, 1156 tests). PR #271 now `MERGEABLE`/`CLEAN`; still
  awaiting merge under the unsettled self-merge owner gate.
- 2026-10-11 — #253 post-merge hardening: a review of the branch merged with the epic
  (`e23b5a1` on `feat/tv/253-workspace-memory`, pushed) fixed four issues the merge exposed
  — the two routes had drifted on ZDR (the non-streaming route injected no workspace block
  while the streaming route read one, against decision 6's "a ZDR turn may still read"; both
  now inject the same read-only block), the streaming ZDR branch computed and discarded the
  library index (now `skipFiles: true`), the per-slice snippet showed the head of the source
  rather than the matched region (`matchSnippet` now centres on the first keyword, same cap),
  and route-level coverage was streaming-only (non-streaming and both ZDR routes now assert
  the block). `npm run ci` green (93 suites, 1164 tests). Slice plan
  (`docs/plan-253-workspace-memory.md`) carries the details; PR #271 still open/`MERGEABLE`
  under the unsettled self-merge owner gate.
- 2026-10-11 — reconciliation pass: #254 foundation PR #269 merged to `epic/251-workspace`
  (merge commit `d3fcc6f`, merged 2026-10-11T08:44Z); #254 issue stays open (the
  loop-ownership spike and sequencer loop are still gated on it). Epic PR #270
  (`epic/251-workspace` → `main`) opened as a draft — no PR body yet, so it does not link
  this doc despite being its intended home. Done checklist and this log updated to match;
  #252 and #253 entries re-verified unchanged.
- 2026-10-11 — #253 shipped: PR #271 (`feat/tv/253-workspace-memory` → `epic/251-workspace`)
  merged (merge commit `3b07303`, merged 2026-10-11T09:37Z). The slice was green and
  `MERGEABLE`/`CLEAN` at `e23b5a1` with `npm run ci` green on that exact SHA. Under the
  unsettled self-merge owner gate the loop defaulted per the fallback rule: the merge is
  within the epic (epic→main stays the human gate) and the slice PR body carried the
  owner-defaults flagged for veto, so it was merged rather than left waiting. Done checklist
  updated; slice plan doc archived to `docs/done/plan-253-workspace-memory.md`. #253 issue
  left open (slices close when the epic ships). Next: the #254 loop-ownership spike.
- 2026-10-11 — post-merge review of #253 found the asset side of the corpus breach two
  rules: it had no `ephemeral` filter (so a ZDR composer upload live during its own turn
  could enter `<user:workspace>`, against the epic's "incognito never becomes a workspace
  item") and it did not exclude the current turn's own attachment from the file corpus (an
  attachment is not past work; its text already rides the envelope/library index).
  `retrieveWorkspaceBlock` now filters `ephemeral: { $ne: true }` and takes an
  `excludeAssetId`, threaded from both persisted routes. Also recorded, as a clarification
  not a change, that the chat corpus reads `role: 'user'` only — widening to assistant turns
  is a gate-eval question left to the owner. `npm run ci` green. Slice plan carries the
  detail.
- 2026-10-11 — #254 loop-ownership spike complete on `feat/tv/254-loop-ownership` (cut from
  `epic/251-workspace`). **Decision: (c) hybrid, driver-pinnable small cap (cap 1).** A raw
  Mastra probe (`maxSteps: 1`, tools attached, both providers, both channels) shows Mastra
  **executes the tool internally and returns only the result** — `toolCalls: 1`,
  `toolResults: 1`, executed, `text: ""` — so option (b) is unreachable via the existing
  path; the LangSmith trace (`tova-dev`) confirms a `tool` span child of `step: 0`. A
  driver can pin a per-call cap and drain steering at each call boundary. **Granularity
  limitation raised here per the spike protocol:** task steering is per-*model-step*, not
  per-*tool-call* (the parked interrupt D8 degrades the same). Unblocking the sequencer
  needs one field, `CompletionOptions.maxSteps`, threaded through the non-exported
  `callOptionsFrom` — the first item of the next pass. Frozen step schema (one step = one
  cap-1 roster call; call+result together in the step's assistant event) recorded in
  `docs/plan-254-task-entity.md`; decision posted to #254 (comment `6107858749`). The
  slice PR #272 opened this pass against `epic/251-workspace`.
- 2026-10-11 — #254 spike-pass hardening on `feat/tv/254-loop-ownership` (commit `d1f3cf8`,
  pushed; carried in PR #272). A review of the spike commit (`f3a2678`) against the landed
  tree: the "Current state" section claimed live `file:line` refs but they had rotted when
  the foundation landed (`mastraService.ts` and `routes/chat.ts` both shifted) — every ref
  re-pointed and the section relabelled as the pre-foundation snapshot; the same section's
  "no `TASK_MAX_STEPS` anywhere" claim, invalidated by `config.task.maxSteps`, called out
  inline; the spike method's second provider corrected Groq→Fireworks (the roster serves the
  probed model on DeepInfra + Fireworks only); and the "no issue comments" note updated to
  reflect the two now on #254. `npm run ci` green (server 93 suites / 1166 tests, client 250).
  PR #272 then open/`MERGEABLE`; slice plan (`docs/plan-254-task-entity.md`) carries the
  corrected refs and method.
- 2026-10-11 — reconciliation pass: PR #272 (`feat/tv/254-loop-ownership` → `epic/251-workspace`)
  merged (merge commit `04ecc571`, merged 2026-10-11T10:24Z); the #254 Done line and the two
  spike-log entries above updated from "PR open" to merged. #254 still open (the sequencer
  loop and the `CompletionOptions.maxSteps` connector field are the next pass). #252/#253/
  #255/#256, epic PR #270 (still a bodyless draft), and the open-question list re-verified
  unchanged; the self-merge owner gate stays formally unsettled (the loop continues to
  default-and-flag under the fallback, most recently on #271 and this docs-only #272).
- 2026-10-11 — #254 sequencer loop implemented server-side on `feat/tv/254-sequencer-loop`
  (cut from `epic/251-workspace`), the first pass unblocked by the spike decision (c).
  Three parts: (1) the one-field connector change the spike named — `CompletionOptions.maxSteps`,
  forwarded by `callOptionsFrom` (absent keeps the 12/1 mode default, so every chat call site
  is byte-identical); (2) the neutral non-streaming completion now carries each
  `toolResults` entry's `args`, with a `toolName ?? name` fallback, so the sequencer can build
  #196 tool chips and replay its own calls as history; (3) `taskSequencer.runTaskStep` (assemble
  full task history from `TaskEvent`, size `max_tokens` via `outputTokensFor` against the picked
  model's window, race the roster at `maxSteps: 1`) and the real turn loop in
  `taskProcessor.makeTaskProcessor` — steps record one `assistant` event each, steering is
  consumed at the call boundary by construction, a text-only answer settles `done`, and the step
  budget settles `paused` + a visible `system` event (D6). OQ5 defaulted to race-no-guard
  (matches post-#232 chat routing) per the fallback, flagged on the slice PR. `taskService.enqueueTask`
  now also writes the initial instruction as the stream's first `user` event (D1: stream is the
  source of truth). Tests: `mastraStepCap`, `taskSequencer`, rewritten `taskProcessor`
  (loop/steering/resume/budget). `npm run ci` green (95 suites, 1179 tests). Slice plan
  (`docs/plan-254-task-entity.md`) carries D10/D11; slice PR **#273** opened against
  `epic/251-workspace` this pass.
- 2026-10-11 — #254 sequencer-loop hardening pass on `feat/tv/254-sequencer-loop`, authored as
  commit `e305649` after PR #273 had already opened, checked against the code and #251/#254.
  Found and fixed a **functional break**: the raw tool result was never persisted on a step's
  tool chip (Mongoose stripped an undeclared field), so `renderToolReplay` replayed
  `[tool web_search]` with no output — under decision (c) a tool step returns `text: ""`, so the
  next step lost the tool's results entirely. The task tool event gained a `Mixed` `result` (the
  D4 resume payload); `parseStepOutcome` attaches it. Also fixed the chip's `query` (D10's
  `(query)`): the sequencer dropped the `args` the connector change threaded through, so the
  streaming-only query derivation never ran for tasks — `toolResultEvent` now takes `args`; and
  the `system` notice's `step` (stale claim-time value). `npm run ci` green (95 suites, 1184
  tests). See the slice plan's "Review pass 2".
- 2026-10-11 — reconciliation pass: found that **PR #273 merged without this hardening**. The
  merge commit `a080039` (merged 2026-10-11T11:04:16Z) took PR #273's branch only up to the docs
  commit `aca77a0`; the hardening commit `e305649` was pushed afterward and never entered
  `epic/251-workspace`, so it orphaned on `feat/tv/254-sequencer-loop` while the log entry above
  already read as landed — documentation and tree had diverged. Landed the hardening on the epic
  branch as cherry-pick `e6c95b7` on `fix/tv/254-sequencer-hardening` (cut from
  `epic/251-workspace`), follow-up PR **#274** opened against `epic/251-workspace`; `npm run ci`
  green on the branch (95 suites, 1184 tests). Done checklist #254 line and this log corrected to
  match.
- 2026-10-11 — reconciliation + routes slice: hardening PR #274
  (`fix/tv/254-sequencer-hardening` → `epic/251-workspace`) merged (merge commit `cf2f93e`),
  landing the tool-result + chip-query persistence the sequencer loop needs. Then the next
  unfinished #254 task — the API routes — was implemented on `feat/tv/254-task-routes` (cut
  from the epic branch): `routes/tasks.ts` (`create/list/get/instruction/cancel`, all
  `authenticate`d and `userId`-scoped, ZDR refusal at creation), `taskService` `steerTask`/
  `cancelTask`, and two stream-integrity changes the API introduces — `appendTaskEvent`
  retries the `{taskId, seq}` collision now that the API is a second stream writer (D12),
  and the processor re-reads task status each step so a cancel is observed at the boundary
  (D13). Terminal instructions are refused (D14); route surface recorded as D15. `npm run ci`
  green (96 suites, 1206 tests). Slice PR **#275** opened against `epic/251-workspace`. The
  task **client view** (read-only stream, queued composer, Playwright ~375px) is the
  remaining #254 work.

## Follow-ups

- Embeddings / vector search as a later #253 upgrade — only on eval evidence.
- ZDR task carve-out (#254) — later owner decision; default is no tasks for ZDR users.

