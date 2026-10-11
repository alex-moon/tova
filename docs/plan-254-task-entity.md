# Plan — #254 Task entity: offline agent sequencer over the workspace

## Motivation

Per GitHub issue [alex-moon/tova#254](https://github.com/alex-moon/tova/issues/254),
slice of epic [#251](https://github.com/alex-moon/tova/issues/251).

From #166: some agent work needs far more than the 12-tool chat cap, runs unattended
("offline" = no user connection required, not a separate process), and should be
steerable while running. The epic re-think is that a **task is a first-class stream — a
twin of a chat, not a chat's child.** A task is its own persisted stream in its own
collections; it reuses the *shapes* the chat built (message rows, tool events) but never
entangles `Message` with a `taskId`.

This slice lands the Task entity, the worker-driven sequencer, and the steering model.
It is deliberately the largest slice of the epic and is the one that establishes the
runtime every later workspace slice builds on.

**Plan-doc location (RESOLVED this pass).** `docs/workflow.md:31` mandates ticket plans live
at `docs/plan-<n>-<summary>.md`, and `docs/workflow.md` (Epics §3) says a slice's plan lives
on the **epic branch** (`epic/251-workspace`). The doc now lives at
`docs/plan-254-task-entity.md` on the slice branch `feat/tv/254-task-foundation` (moved out
of the orchestrator's `.iteration/` scratch this pass). The "archive to `docs/done/`" step
now operates on a real `docs/` path.

**The ticket's first deliverable is a loop-ownership spike, and this plan is honest about
that: the sequencer's steering granularity cannot be designed until the spike answers who
owns the tool loop.** The spike is therefore the first checklist section, and the
implementation sections are written at the level the epic has already bound (Task model,
generalised poller, per-step roster racing) while the loop-ownership-dependent parts are
marked conditional and tracked as an open question — not invented ahead of evidence.

## Binding design (from the epic — treated as decisions, not open)

These are fixed by the epic (`#251`, quoted in the ticket body) and are not re-litigated
here. Where this plan adds concrete shapes, it does so to make them implementable.

- **D1 — Task is a persisted stream in its own collections.** `Task` + task stream events
  in separate collections. Reuse the message/tool-event *shapes* (`PersistedToolEvent`,
  `#196`) but **never add `taskId` to `Message`** and never write a task message into the
  `messages` collection. Task fields: status, origin reference (session or none), queued
  instructions, step/budget accounting.
- **D2 — Sequencer: worker-driven turn-taking.** Steering messages queue and are consumed
  at **step boundaries** (the OpenCode model) — "chatting with the task" and "steering
  it" are the same mechanism; the task detail view is a chat view with queued
  turn-taking. A steering message is just the next queued user turn.
- **D3 — Scope: the workspace, via the existing security model.** Tools run under the
  user's `userId`/`RequestContext` exactly as chat tools do (per-call `RequestContext`,
  `mastraService.ts:236`), so a task needs no chat — its scope was never conversational.
  **Direct-origin tasks** (user starts with an initial instruction, no chat) are
  first-class; the origin reference is optional.
- **D4 — Runtime: generalise `assetJobService`'s claim/retry/poller.** In-process is
  accepted for v1. Crash recovery: the persisted stream is the resume state
  (reassemble the conversation from the stream and continue the loop); a stale-`processing`
  sweep re-queues like assets (`assetJobService.ts:100-108`).
- **D5 — Routing: per-step roster racing via `raceRosterCompletion`.** Non-streaming
  completion per step is fine; the client gets progress from the task stream, not the LLM
  stream. Steps assemble from **full task history**, not the chat path's 10-message window
  (`routes/chat.ts:791-793`), and size `max_tokens` against the picked model's
  `contextLength` as today (`outputTokenCap.ts:30-40`).
- **D6 — Budgets.** `TASK_MAX_STEPS` env (no magic constants); a per-task running cost
  meter from per-step usage (#224) × roster prices (#235), hard-stopped at a configurable
  budget. This plan settles the meter/pause/confirm-on-breach behaviour below.
- **D7 — ZDR.** Tasks are durable by definition, so **ZDR users do not get tasks** (the
  default). A carve-out is a later owner decision, not this slice.
- **D8 — Interrupt is parked, deliberately.** Expected to fall out of steering as a
  *sequencing override* ("abort the in-flight call, act like a chat for one turn"); the
  abort plumbing exists (racing's per-provider `AbortController`s,
  `racingService.ts:206-235`). **Not a deliverable of this slice.**
- **D9 — This pass ships the foundation only, with an honest stub driver.** The
  queue/model/runtime (D1/D4 data layer + poller) lands now; the sequencer turn loop
  stays blocked on the loop-ownership spike (OQ9's `maxSteps`-pinning). **The spike
  has since answered this (decision (c), cap 1; see "Spike result"): the loop is
  unblocked in principle and needs one connector field (`CompletionOptions.maxSteps`)
  before it can be built — the first item of the next pass.** Rather than lose
  claimed tasks or fake their completion, the wired `processTaskJob` transitions a
  claimed task to **`paused`** with a visible `system` stream event (the same
  mechanism D6 uses for a budget breach). This keeps the runtime real and
  self-healing while the driver is a separate slice; resumption is a queued
  instruction once the sequencer lands.

## Current state (re-verified against the working tree, 2026-10-10)

Describes the tree **as it was before the foundation landed** (the snapshot that motivated
D9's stub). File:line references below were re-pointed to the current tree on 2026-10-11 to
stay live; the one claim the foundation has since invalidated is called out inline.

- **The chat agent loop is owned by Mastra, not the route.** The route
  (`routes/chat.ts`) only *observes* neutral chunks (delta / tool-call / tool-result) and
  reconciles them (`chat.ts:1202-1224`); tool **execution is inside Mastra's agent loop**.
  `maxSteps` is set in exactly two places: `12` for chat tools mode, `1` for plain
  (`mastraService.ts:248`), and tool-free completions pin `maxSteps: 1`
  (`mastraService.ts:931`). At this snapshot there was **no `TASK_MAX_STEPS`** anywhere
  (confirmed by grep); the foundation has since added it as `config.task.maxSteps`
  (`config/index.ts:158`, see the Foundation checklist below), so that claim is now only
  true of the pre-foundation tree.
- **Tools are baked into the agent at construction** (`mastraService.ts:713-752`), while
  the per-call `RequestContext` carries `userId` (`mastraService.ts:231-247`). This is the
  exact seam a task worker must replicate: agents are memoised, per-user state rides on
  the call, never the agent.
- **`PersistedToolEvent`** is defined at `routes/chat.ts:303` as
  `(ToolCallEvent | ToolResultEvent) & { query?: string }`, reconciled by
  `reconcileToolEvent` (`chat.ts:314`), and persisted on `Message.tools`
  (`models/Message.ts:75-89`). The task stream reuses this shape; it does **not** go into
  `Message`.
- **Per-step routing for tasks is `raceRosterCompletion`** (`racingService.ts:370-432`).
  The chat routes call the wrappers `routeAndStream`/`routeAndComplete`/`pickRosterRoute`;
  a task worker can call `raceRosterCompletion` directly. `contextLength` → `max_tokens`
  is `outputTokensFor` (`outputTokenCap.ts:30`), already used by the non-streaming chat
  path (`chat.ts:857`, `:1185`).
- **Poller template is `assetJobService`** (`assetJobService.ts`): `enqueueAssetJob`
  (`:27`), atomic `claimNextAssetJob` (`:41`, `pending → processing` + attempts bump),
  `runAssetJobTick` (`:53`, retry to `MAX_JOB_ATTEMPTS=3`), `requeueStaleAssetJobs`
  (`:100`, stale = 5 min), `startAssetJobPoller`/`stopAssetJobPoller` (`:110-134`). All
  background pollers are wired in `index.ts:158-187` **inside
  `if (process.env.NODE_ENV !== 'test')`**, and the `AssetJob` model
  (`models/AssetJob.ts`) is the queue archetype (compound `{status:1, createdAt:1}` index).
- **No task/stream model exists.** `models/` has `Asset`, `AssetJob`, `Entity`,
  `EntityEdge`, `ErrorLog`, `EvalRunRecord`, `McpServer`, `Message`, `ModelRoster`,
  `ModelRouteError`, `Pat`, `SafeBrowsingCache`, `Session`, `TraceStatsCache`, `User`.
  The task stream collections are net-new.
- **ZDR is `User.settings.zdr`** (`models/User.ts:76,150`), read per turn via
  `decideTurn` (`zdrTurn.ts:30-37`); chat reads `Boolean(userDoc.settings?.zdr)` at
  `chat.ts:645,978`. D7 uses this same flag to refuse task creation.
- **Config is central and lazy** (`config/index.ts`), with a parse+fallback pattern for
  numeric envs (`aux.enrichmentTimeoutMs` at `:140`). `TASK_MAX_STEPS` belongs here,
  not read ad hoc.
- **Cost precedent exists.** Per-session usage × prices is computed in
  `sessionCostService.ts` (`sessionCostBreakdown`, `:55`); roster prices are
  `inputPrice`/`outputPrice` in `rosterConfig.ts` (#235). Per-step usage is
  `NeutralCompletion.usage` (`llmTypes.ts:100`), normalised in
  `mastraService.normaliseUsage` (`:138`).

- **The non-streaming path already executes tools internally.** `createCompletion`
  (`mastraService.ts:872`) calls `agent.generate(...)`, and the only tool information it
  surfaces is `FullOutput.toolResults` (`:884`) — i.e. **already-executed** calls with
  their results. It returns `toolResults`, *never* a bare tool-call for a caller to run.
  The `tool-call` vs `tool-result` distinction lives only in `toNeutralStream`
  (`:156-186`), which is consumed solely by `createStreamingCompletion` (`:900`). So
  today, on both neutral completion channels, tool execution happens **inside Mastra** —
  there is no existing return path that hands a driver an unexecuted call.
- **`maxSteps` is not a call-site knob.** It is hardcoded in `callOptionsFrom`
  (`mastraService.ts:248`) as `mode === 'full' ? 12 : 1`, and `callOptionsFrom` is not
  exported. Option (a) ("`maxSteps: TASK_MAX_STEPS`") therefore **cannot be set by a task
  worker alone** — it requires changing `callOptionsFrom` and/or `CompletionOptions`.
  `createToolFreeCompletion` is the only call that pins a literal `maxSteps: 1`
  (`:931`), and it uses a *tool-free* agent, so it cannot be the driver-owned executor.
- **`raceRosterCompletion` inherits the tool-executing path.** It calls
  `inferenceService.createCompletion` (`racingService.ts:379`), i.e. full-mode
  `createCompletion` with tools baked into the agent (`agentFor`, `:713-752`). Whatever a
  task does per step, racing a step runs Mastra's tools *inside* that call unless the
  driver deliberately routes a tool-free completion and executes tools itself.

**Not verified this pass (spike must answer):** whether a Mastra agent call with
`maxSteps: 1` **returns** tool-call content for the *driver* to execute, rather than
executing the tool itself and returning only the result. **ANSWERED by the spike
(2026-10-11): Mastra executes the tool itself and returns only the result — (b) is
not reachable via the existing path. Decision is (c).** See "Spike result" above for
the raw evidence and trace. The earlier note below stands as the reasoning that
motivated the probe. Critically, the evidence above shows the question cannot be answered
by observing `createCompletion` as it stands — that method already collapses call+result
into `toolResults`. The spike must probe Mastra's raw output (or a new connector shape)
to see whether a call/execute split is even reachable. `toNeutralStream` distinguishing
`tool-call` from `tool-result` (`:166-184`) is *suggestive* but comes from the streaming
path and with tools attached Mastra's internal loop may emit both within one call. Note
the distinction is a *transport* distinction, not proof of who executes: `toNeutralStream`
reads Mastra's `fullStream` chunks, and with `maxSteps > 1` a single call emits the
`tool-call` chunk *and then* the `tool-result` chunk for the *same* call because Mastra
executed it in between. Seeing a `tool-call` chunk is therefore **not** evidence that a
driver can take over execution.

**Additional doubt this pass (corrected while verifying).** The first draft of this note
suspected a task worker calling `raceRosterCompletion` would skip a guard the chat path
applies. **That is wrong and worth recording as a checked assumption:** since #232 the chat
path itself no longer uses the guard classifier — the chat routes call `pickRosterRoute`
then `routeAndComplete`/`routeAndStream`, and the code says plainly "Racing never calls the
guard" (`chat.ts:715`, `:1043`). `routeAndComplete`/`pickRosterRoute` (`racingService.ts:480`,
`:528`) add **no policy** beyond racing and shaping the `RosterRoutingResult`; they are thin
wrappers over `raceRosterCompletion`/`raceRoster`. So a task worker calling
`raceRosterCompletion` directly is **consistent** with how the chat path routes today, not a
regression. The remaining genuine question is narrower: whether a task step should
reintroduce the guard/tier decision (the epic's "router selects models by complexity") or
inherit the chat path's post-#232 roster-race-only behaviour. See OQ5.

## First deliverable — the loop-ownership spike

**Who owns the tool loop? Steering granularity depends on it.** The spike must produce a
**decision plus evidence** (a scratch script under `.iteration/` or `scripts/`, and/or a
LangSmith trace), recorded on this ticket. The step schema and the steering UX depend on
it, so nothing downstream is implemented before it lands.

Three candidate architectures (from the ticket):

- **(a) Mastra's internal agent loop** (`maxSteps: TASK_MAX_STEPS`). Least work; worst
  steering latency — the whole cap is a black box, so a steering message cannot be
  consumed at a step boundary the driver cannot see.
- **(b) Driver-owned loop** — one model call at a time, the driver executes tools and
  feeds results back (the OpenCode architecture). Per-call steering; bypasses Mastra's
  agent abstraction. **Open question the spike must answer: can an agent call with
  `maxSteps: 1` return tool calls for the driver to execute?**
- **(c) Hybrid** — Mastra runs with a small cap (3–5), the driver drains steering between
  runs. Middle ground; steering granularity is the small cap, not one step.

### Spike method (concrete, evidence-first)

The probe must target the **raw Mastra call**, not the neutral wrapper, because the
wrapper is the thing suspected of hiding the answer (see "Not verified" above).

1. **Probe the raw `generate` result at `maxSteps: 1` with tools attached.** Add a scratch
   script (`.iteration/` — see the existing `scripts/eval-model-compare.ts` for the roster
   setup and `.iteration/guard-budget-probe-169.ts` for the scratch convention). Build a
   `full` agent via the same path `agentFor` uses (`mastraService.ts:713-752`) or call
   `agentFor(provider, model).generate(messages, { maxSteps: 1 })` directly, with a prompt
   that forces exactly one tool call (e.g. "read the file `x.md` and tell me its first
   line"). Capture the **entire raw `result` object** — not `result.text` and not
   `toolResults` — and inspect: does it contain a *tool-call* entry separate from a
   *tool-result* entry, or only the latter? Whether the tool actually executed is the
   signal that decides (a) vs (b).
2. **Read the wire, not just the wrapper.** If the raw `generate` object is opaque, run the
   **streaming** variant (`createStreamingCompletion`) at `maxSteps: 1` and log the raw
   `fullStream` chunks before `toNeutralStream` maps them. If the stream shows a
   `tool-call` chunk followed by a `tool-result` chunk *within the same call*, Mastra owns
   execution (Mastra → (a)/(c)). If a call at `maxSteps: 1` can terminate on the
   `tool-call` chunk without a following `tool-result`, (b) is reachable. Confirm against
   the LangSmith trace (project `tova-dev`) — the trace's span tree shows whether a tool
   span is a child of the model call (Mastra executed) or absent (driver would execute).
3. **Run against both providers of one roster model** (the roster's `ROSTER_PROVIDERS`
   are DeepInfra + Fireworks, `rosterConfig.ts:19`; e.g. both providers of DeepSeek V4.1
   Flash) to confirm the call-vs-execute behaviour is not a provider quirk. Record any
   divergence. (An earlier draft of this method named Groq as the second provider; the
   roster does not serve this model on Groq, so the executed probe used DeepInfra +
   Fireworks — see "Spike result".)
4. **Check the driver-owned shape is buildable without forking Mastra.** If (b) is
   reachable, determine the smallest change that lets the driver receive a tool call and
   feed a result back as the next message. Two candidate shapes, both probed in the same
   script: (i) reuse `createToolFreeCompletion`'s tool-free agent and replay
   assistant-tool-call / tool-result turns as plain messages — but this loses the
   workspace tools (`read_file`, `list_files`, `fetch_url`, `generate_file`,
   `current_datetime`, `web_search`), which are Mastra-side tools, so the driver would have
   to re-implement them; (ii) add a new `LlmConnector` method that returns unexecuted
   calls (the neutral boundary is `llmTypes.ts:103-133`, the `NeutralStreamChunk` /
   `LlmConnector` shapes). Report which, if either, is
   viable and its blast radius.
5. **Decide and record.** Post the decision (a | b | c) with the raw evidence and the
   LangSmith trace link to #254. The step schema and steering UX in the sections below are
   then finalised against it. If the answer is (a) or (c) — i.e. the driver *cannot*
   observe a single step — state plainly that the epic's "steering at step boundaries" and
   the parked interrupt both degrade to the small-cap granularity, and raise it on the
   epic (#251) rather than silently shipping coarser steering.

### Spike checklist

- [x] Spike script added (`.iteration/loop-ownership-probe-254.ts`, scratch, not committed —
      a one-time evidence probe, same convention as `.iteration/guard-budget-probe-169.ts`),
      forcing a tool call at `maxSteps: 1`.
- [x] Probe run against a roster model on both providers; raw output captured.
- [x] LangSmith trace read for the probe (project `tova-dev`) to confirm call-vs-execute
      interleaving.
- [x] Decision (a | b | c) + evidence posted to #254.
- [x] Step schema and steering granularity frozen against the decision (feeds section
      below).

### Spike result — DECISION: (c) hybrid, driver-pinnable small cap (2026-10-11)

**Decision: option (c) — the hybrid — with the driver pinning the per-call step cap.**
The driver calls the roster race once per *driver step* with a **small `maxSteps`
cap** (proposal: `maxSteps: 1`), reads the step's messages/results out of the
returned completion, **drains steering at that call boundary**, then calls again.
Steering granularity is therefore **one model call + its tool executions per
driver step** — the hybrid's "small-cap boundary", with the cap set to 1 so it is
a *single* step, not a hidden 3–5 black box.

**Why not (b).** The evidence below shows a Mastra call at `maxSteps: 1` **always
executes the tool itself** and returns only the *result*; there is no return path
that hands the driver an unexecuted call. Reaching (b) would require a new
`LlmConnector` method plus a driver-side re-implementation of all six workspace
tools (`read_file`, `list_files`, `fetch_url`, `generate_file`, `current_datetime`,
`web_search`) — a large blast radius that is Mastra's whole tool-layer, for a
steering benefit (per-*tool-call* granularity) that (c)-at-cap-1 already delivers
within one call's error. (b) is rejected as unreachable-without-forking.

**Why not (a).** `maxSteps: 12` (today's full-mode default) hides the entire cap
inside Mastra; a steering message cannot be consumed at a boundary the driver
cannot see. (a) degrades steering to "after the whole task", which fails the
ticket's "steerable while running".

**Evidence (both providers, both channels — no divergence).**

1. **Raw probe (`.iteration/loop-ownership-probe-254.ts`).** A `full` agent built
   exactly as `agentFor` does (tools baked in, one probe-local marker tool whose
   `execute` increments a counter), a prompt forcing exactly one tool call, called
   at `maxSteps: 1`:

   - Non-streaming `generate` (DeepInfra **and** Fireworks `deepseek-v4p1-flash`):
     `steps.length = 1`, `toolCalls.length = 1`, `toolResults.length = 1`,
     `text = ""`, **marker tool executed count = 1**. The tool ran *inside* the
     call.
   - Streaming `stream().fullStream` (both providers): chunk order is
     `… tool-call, tool-result, step-finish, finish` **within the same call**, and
     **executed count = 1**. The `tool-call` is immediately followed by the
     `tool-result` because Mastra executed it in between.
   - The returned `result.messages` object exposes the step's assistant turn
     (`{ role: 'assistant', content: [{ type: 'tool-call', toolName, input }] }`)
     **plus** the tool turn (`{ role: 'tool', content: [{ type: 'tool-result', … }] }`)
     — i.e. even the call+result split is visible *post hoc*, but both are already
     produced by Mastra. A driver can read them to (a) observe step boundaries and
     (b) build the next call's history; it cannot *pre-empt* execution.
   - `text = ""` at `maxSteps: 1` is the key operational fact: a single-step call
     that chose a tool returns **no final answer**; the driver must feed the result
     back as history in the next call. That is exactly the (c) loop.

2. **LangSmith trace (project `tova-dev`, non-streaming DeepInfra probe).** The span
   tree is decisive:

   ```
   agent run: 'probe-deepinfra' (chain) [1.49s]
   └── llm: 'deepseek-ai/DeepSeek-V4.1-Flash' (llm) [1.40s]
       └── step: 0 (chain) [1.63s]
           ├── inference: 0 (chain) [1.29s]
           │   ├── chunk: 'text'
           │   ├── chunk: 'tool-call'
           │   └── chunk: 'tool-result'
           └── tool: 'probe_marker' (tool) [6ms]
   ```

   The `tool: 'probe_marker'` span is a **child of `step: 0`** — Mastra owns
   execution. There is no span shape where a tool call leaves the process
   unexecuted for the caller. The `step: 0` span is also the boundary a driver can
   observe: one `step` span per driver step when the cap is 1.

**Smallest change that makes (c) reachable with cap 1.** `maxSteps` is currently
hardcoded in the non-exported `callOptionsFrom` (`mastraService.ts:248`:
`mode === 'full' ? 12 : 1`) and `createCompletion`/`createStreamingCompletion`
always call it in `full` mode. The change is to thread a per-call step cap:
`CompletionOptions.maxSteps?: number`, forwarded by `callOptionsFrom` (falling back
to the current `12`/`1` when absent), so `raceRosterCompletion` — which passes
`...options` straight into `createCompletion` (`racingService.ts:403`) — carries it
through. Blast radius: one optional field on `CompletionOptions`
(`llmTypes.ts:39`), one line in `callOptionsFrom`, and the connector forwards it
(the `plain` tool-free path keeps its literal `1`). Existing chat call sites send
no `maxSteps` and are byte-identical. This is the connector change that unblocks
OQ9, and it is the first implementation item of the *next* pass — **not** part of
this spike pass, which records the decision only.

**Consequence for the rebooted steering model.** Steering is drained **once per
driver step** (one `maxSteps: 1` roster call). This is coarser than per-*tool-call*
steering (which (b) would give and which the ticket's "at step boundaries" wording
aspires to) but is a real boundary the driver sees, unlike (a). Per the spike
protocol's step 5, because the answer is not a clean (b), this granularity
limitation is **raised on the epic (#251)** in the process log: task steering is
per-model-step, not per-tool-call, unless a future slice builds the (b) connector.
The parked interrupt (D8) degrades equally to the per-model-step boundary.

### Frozen step schema (feeds the sequencer implementation)

Against decision (c)-at-cap-1, a **step** is one `maxSteps: 1` roster call. The
`TaskEvent` rows a step produces (D1's stream, unchanged shape) are:

- One `assistant` event per step: `content` = the step's text (may be `""` when the
  step chose a tool), plus `tools` = the step's `toolCall`/`toolResult` entries
  (the `PersistedToolEvent` shape), `model`/`provider` = the race winner, `usage`
  from the step, `step` = the step ordinal.
- Tool **results** are part of the same `assistant` event's `tools` (Mastra returns
  call+result together); there is no separate driver-executed `tool` event in (c),
  because the driver does not execute tools. A `tool`-role event stays reserved for
  any future (b) path.
- A `system` event records steering consumption and budget breaches (D6).
- The next driver step's history is reassembled from all prior `TaskEvent` rows
  (D5: full task history, not a 10-message window), with the tool-result content
  replayed as assistant/tool turns so the model sees its own calls.

Steering is consumed at the **call boundary**: after a step's event is written and
before the next `maxSteps: 1` call is issued, the driver drains queued `user`
instructions into the history.

## Implementation outline (only the parts independent of the spike decision)

The following is safe to build **before or alongside** the spike because it does not
depend on loop ownership: the data model, the poller/claim/retry machinery, the per-step
routing call, and the budget meter. The sequencer loop itself is intentionally **not**
specified to the commit level here — it depends on the spike (OQ1), so its checklist
items are conditional and grouped under "Sequencer (gated on the spike)".

### Task model (D1)

- `models/Task.ts` — a `Task` document: `userId` (ref User, required), `status`
  (`queued | running | paused | done | failed | cancelled`), `origin`
  (`{ kind: 'chat', sessionId } | { kind: 'direct' } | absent` — optional reference, never
  a `Message` FK), `instruction` (the initial/steering text is *also* a stream event; this
  scalar is the seed for listing/summary, not the source of truth), `stepCount`,
  `budget` (`{ maxSteps?, maxCostUsd?, spentUsd? }`), `lastError`, timestamps.
- `models/TaskEvent.ts` — the stream. One row per event in order: role
  (`user | assistant | tool`), content, `model`/`provider`, reusable
  `PersistedToolEvent`-shaped `tools`, `usage`, `step`, `timestamp`. Ordered by
  `{ taskId, seq }` with a compound index. A steering message is a `user` row appended at
  a step boundary (D2).
- **No change to `Message` or `Session`** — this is a hard invariant of the slice.

### Sequencer runtime (D4), generalised from `assetJobService`

- Generalise the claim/retry/stale-sweep pattern. Prefer **extracting a small generic
  `claimNext(collection)`/stale-sweep helper** over copy-paste, but only if it does not
  complicate the asset path; otherwise mirror the shape with a `Task`-specific service.
  Decision recorded when the spike-adjacent work starts (see OQ2 on the exact factoring).
- `Task.status` claim: `queued → running` atomically (`findOneAndUpdate`, oldest first),
  attempts bump, `MAX_TASK_ATTEMPTS` (reuse the `assetJobService` retry idiom;
  `TASK_MAX_STEPS` is the *step* cap, distinct from the retry cap).
- **Crash recovery** = the stream is the resume state: on restart, `running` tasks older
  than a stale window are re-queued (`assetJobService.ts:100-108`), and the loop resumes
  by reassembling history from `TaskEvent` and continuing from `stepCount` — no separate
  checkpoint document. **Caveat (OQ7):** whether a resumed task continues *counting
  toward* `TASK_MAX_STEPS`, and whether a stale-requeue counts as an attempt against
  `MAX_TASK_ATTEMPTS`, is unsettled; the plan's mechanism (continue from `stepCount`)
  assumes steps are monotonic across a crash, which is only true if a partially-written
  step is discarded. The event write must be the atomic unit a step advances on.
- Poller started in `index.ts` under the existing `NODE_ENV !== 'test'` gate
  (`index.ts:158-187`), stopped on shutdown like the asset poller.

### Per-step routing + budget (D5, D6)

- Each step calls `raceRosterCompletion(options, hasImage)` with the full task history
  assembled from `TaskEvent`, `userId` set (D3), and `max_tokens` =
  `outputTokensFor(routing.contextLength, promptChars)`. Store the winning
  `model`/`provider` and `usage` on the step's assistant event.
- **`TASK_MAX_STEPS`** added to `config/index.ts` (default settled here; proposal: `25`
  — above the chat cap of 12, below a runaway; owner may override). No magic constant.
- **Cost meter:** running `spentUsd` = Σ per-step `usage` × roster prices (#235),
  persisted on `Task.budget.spentUsd` (or derived from `TaskEvent.usage` + a
  price-at-time snapshot — see OQ3). **Breach behaviour (settled here):** when either
  `TASK_MAX_STEPS` or the cost budget is reached, the task transitions to **`paused`**
  (not `failed`, not silent-stop) and the stream records a visible system event stating
  which budget was hit. Resumption/confirmation after a breach is a client affordance
  that appends a new queued instruction — the same mechanism as steering — so breach
  handling adds no new primitive. This satisfies the ticket's "hard-stopped at a
  configurable budget" while keeping the flow steerable.

### API + client (shape only, gated on spike for the interactive parts)

- REST: `POST /api/tasks` (create, honoring D7 ZDR refusal), `GET /api/tasks`,
  `GET /api/tasks/:id` (stream), `POST /api/tasks/:id/instruction` (queue a steering /
  resume message), `POST /api/tasks/:id/cancel`. Auth via the existing `authenticate`
  middleware; ownership enforced by `userId`.
- Client: a task detail view that is **a chat view with queued turn-taking** (D2),
  mobile-first per the standing client rules. The exact turn-taking UX depends on the
  spike; only the read-only stream rendering and the queue-composer shell are plannable
  now.

## Done

Ordered; spike first, then the loop-ownership-independent foundation. Items marked
**[gated]** cannot start until the spike decision is recorded.

### Spike
- [x] Spike script + probe + trace; decision (a|b|c) posted to #254 (see checklist above).
      **Decision: (c) hybrid, driver-pinnable small cap (cap 1); see "Spike result" above.**

### Foundation (independent of the spike; one item also needs OQ5)
- [x] `config/index.ts`: `task.maxSteps` (`TASK_MAX_STEPS`, parse+fallback, default 25) and
      the cost budget env (`TASK_MAX_COST_USD`, default 5), documented next to `chat`/`aux`;
      getters covered in `config/index.test.ts` (unset/malformed/empty/non-positive → default;
      positive → parsed, step cap floored).
- [x] `models/Task.ts` + exported `TaskDocument`/`TaskOrigin`; status enum; origin
      subdocument (`_id: false`, absent allowed) — **no `Message`/`Session` change**.
- [x] `models/TaskEvent.ts` + exported type; `{ taskId, seq }` unique index; `tools` reuses
      the `PersistedToolEvent` shape (imported as a type — enum not duplicated); a `system`
      role added for visible sequencer notices (D6).
- [x] Model tests: origin absence round-trips; status enum enforced; event ordering; unique
      seq per task; tools/usage absent ≠ empty; the `Message` schema carries no `taskId`
      (the invariant is asserted against `Message`, not `Task`).
- [x] `taskService.ts`: `enqueueTask`, `claimNextTask`, `runTaskTick` (retry/cap),
      `requeueStaleTasks` — **mirrored** from `assetJobService` (OQ2 resolved: mirror, not
      extract); unit tests mirror `assetJobService.test.ts` including a paused-not-clobbered
      case. Both tick paths (success *and* failure) settle only a task still `running`, so a
      processor that pauses on a breach and then throws is not requeued.
- [x] Wire `startTaskPoller` in `index.ts` under the non-test gate, with
      `processTaskJob` (the sequencer driver seam); lifecycle test + `isTaskPollerRunning`.
      The processor is an honest stub this slice: it pauses a claimed task with a visible
      system event rather than faking completion (see D9 below).
- [ ] Per-step routing helper: assemble history from `TaskEvent`, call
      `raceRosterCompletion`, size `max_tokens` via `outputTokensFor`; unit test with an
      injected roster/stream (mirror `racingService` test deps at `racingService.ts:93`).
      **OQ9 resolved (spike): the call shape is a per-step `maxSteps: 1` race — frozen.
      Still needs the `CompletionOptions.maxSteps` connector field and OQ5's
      guard-vs-race decision before the helper is written (next pass).**
- [ ] ZDR refusal: creating a task for a `settings.zdr` user is rejected (test). Per OQ8,
      v1 checks at creation only; the test pins that scope explicitly. **Deferred: no task
      creation route exists yet** (API is a later slice), so the refusal has no seam to
      attach to here.
- [ ] Budget meter + breach → `paused` transition with a visible system event (test).
      Meter source of truth settled by OQ3 first; the breach *behaviour* is already
      settled (D6), so only the storage shape is open. **The `paused`+event mechanism is
      built and exercised by the processor stub (D9); the spend meter itself is deferred
      until the sequencer emits per-step usage.**

### Sequencer loop **[unblocked by the spike; next pass]**
- [x] Freeze the step schema (assistant event / tool event / usage) against the chosen
      architecture — **frozen above: one step = one `maxSteps: 1` roster call; call+result
      live together in the step's `assistant` event's `tools`; no driver-executed `tool`
      event under (c)**.
- [ ] Implement the turn loop with steering drained at **call boundaries** (the frozen
      (c) granularity: one model call per driver step), per the decision. **Granularity is
      per-model-step, not per-tool-call — raised on #251 (spike step 5), see the process
      log.**
- [ ] Resume-after-crash test: kill mid-run, re-queue, reassemble from stream, continue
      (see OQ7 on cap interaction).
- [ ] Steering integration test: a queued instruction is consumed at the next boundary.

### API + client **[gated on the spike for interactive parts]**
- [ ] Task routes (`create/list/get/instruction/cancel`), ownership + ZDR tests.
- [ ] Task detail client view, mobile-first; read-only stream first.
- [ ] Queued turn-taking composer per the frozen UX.
- [ ] Playwright at ~375px; `npm run test:e2e` backstop (per standing client rules).

### Gate
- [x] Plan doc moved to `docs/plan-254-task-entity.md` on the slice branch (OQ6 resolved;
      `.iteration/` is scratch, not the convention).
- [ ] `npm run ci` green (server lint/format/typecheck/test, client
      lint/format/test/build).
- [ ] PR opened against the **epic branch** (`epic/251-workspace`), plan doc linked
      (`docs/workflow.md:48-50`).
- [ ] Plan archived to `docs/done/` after the slice PR merges into the epic branch.

## Review pass (2026-10-11)

A hardening pass over the foundation before the `npm run ci` gate. Findings and fixes:

- **`runTaskTick` failure path could clobber a settled task.** The success path already
  guarded `status: 'running'` before settling `done`, but the `catch` unconditionally set
  `queued`/`failed`. A processor that paused on a budget breach (D6) *and then threw* would
  have been silently requeued, defeating the breach pause. Now both paths settle only a
  still-`running` task; test added.
- **The "no `Message` FK" test asserted the wrong schema.** It inspected `Task.schema` for a
  `Message` ref, which would pass even if `taskId` were added to `Message` — the exact
  invariant D1 forbids. Rewritten to assert `Message.schema` has no `taskId` and no `Task`
  ref.
- **`config.task` getters were untested and the new env keys were absent from the config
  test's save/restore list** (so ambient `TASK_*` env could leak between suites). Both
  fixed; parse+fallback + flooring now covered. Also fixed a real parse bug: the
  positivity guard ran *before* `Math.floor`, so `TASK_MAX_STEPS=0.5` produced a zero-step
  budget instead of the default — the floor now happens first and the test pins it.
- **`TaskEvent` carried a redundant `timestamp` *and* `timestamps: true`** (three clocks:
  `timestamp`/`createdAt`/`updatedAt`) unlike its shape-twin `Message`. Dropped
  `timestamps: true`; the single explicit `timestamp` is the stream clock (storage UTC per
  the #254 time contract).
- **Seq allocation clarified, not changed.** `processTaskJob` reads max-seq then inserts;
  safe under the epic's single-writer-per-stream invariant, and the `{taskId, seq}` unique
  index fails loudly if that is ever violated. Recorded rather than hardened with a
  speculative atomic-counter helper the sequencer slice may not want.
- **Out-of-window fix, flagged:** `chat.stream.test.ts` (#261, shipped 2026-10-10) hardcoded
  a `2026-10-08` seed and asserted a "2 days since" gap, so it rots as the clock moves —
  it was already failing `npm run ci` on this branch. Seeds are now relative to `Date.now()`.
  This is genuinely outside this slice; raised here so the epic owner can see the scope was
  stepped into only to keep the required gate green.

## Open questions

1. **Who owns the tool loop? (the spike's whole point.)** **ANSWERED (2026-10-11):**
   Mastra owns execution at `maxSteps: 1` — a call returns only the executed
   tool *result*, never an unexecuted call — so (b) is unreachable without a new
   connector method. **Decision: (c) hybrid, driver-pinnable cap of 1.** See "Spike
   result" above. The remaining work is the one-field connector change
   (`CompletionOptions.maxSteps`), the first item of the next pass.
2. **How far to generalise `assetJobService`?** The ticket says "generalise". Extracting
   a shared claim/retry/sweep helper risks touching the asset path (a non-slice
   subsystem). The plan proposes mirroring the pattern with a task-specific service first
   and only extracting a generic helper if it is genuinely shared — but which of the two
   is a judgement call. **Not blocking** the foundation (either works), but it decides how
   much of `assetJobService` moves, so it should be confirmed before that commit.
3. **Cost meter source of truth: `Task.budget.spentUsd` or derived from `TaskEvent`?**
   Deriving from events is always consistent but recomputes on every read and needs a
   price-at-time snapshot to stay correct if roster prices change; persisting a running
   scalar is cheap but can drift if an event write succeeds and the scalar update fails.
   The plan leans to **derived-from-events with a price snapshot stored per event**, but
   this is not settled and is low-risk either way. **Not blocking.**
4. **Origin reference semantics.** D1 says "origin reference (session or none)" with
   direct-origin first-class. This plan models `origin` as an optional tagged union
   (never a `Message` FK). Whether a task started from a chat should also snapshot the
   originating message id (cf. #252's provenance `messageId`, deliberately left unset
   there) is unresolved and can be additive later. **Not blocking.**
5. **Should a task step reintroduce the guard/tier decision?** The epic's router picks
   models "based on prompt complexity", but since #232 the *chat* path no longer runs the
   guard classifier — it races the roster directly (`chat.ts:715,1043`;
   `routeAndComplete`/`pickRosterRoute` add no policy, `racingService.ts:480,528`). A task
   worker calling `raceRosterCompletion` therefore matches current chat routing and is not
   a regression. The open question is whether tasks **should** diverge by applying the
   complexity tier (the epic's stated intent), or stay on the roster race. Not a
   loop-ownership question, so the spike does not answer it. **Not blocking the
   model/poller foundation, but it blocks the per-step routing helper item** (see Done
   foundation, per-step routing) — that helper's call shape cannot be frozen until this is
   decided.
6. **Where does the plan doc physically live?** `.iteration/docs/` (draft) vs the
   convention `docs/plan-254-task-entity.md` on the epic branch (`docs/workflow.md:40`,
   Epics §3). Resolved by moving the file before the first commit; recorded here only so
   the "archive to `docs/done/`" step is not attempted against a non-`docs/` path.
   **Blocking the Gate's archive item**, not the code.
7. **Is `TASK_MAX_STEPS` distinct from the retry cap, or the same knob?** D6 gives
   `TASK_MAX_STEPS` as the *step* cap; D4 borrows `assetJobService`'s `MAX_JOB_ATTEMPTS`
   idiom for *job* retries. The plan treats them as separate
   (`MAX_TASK_ATTEMPTS` for retries). Whether crash-recovery re-queue counts against the
   step cap, and whether a task that exhausts steps on a transient error should retry the
   whole task or resume mid-stream, is **not settled** and affects the resume design
   (OQ1-gated). **Not blocking the model/poller foundation.**
8. **ZDR refusal check placement.** D7 refuses task creation for `settings.zdr` users.
   Chat reads the flag per turn (`chat.ts:645,978`) and `decideTurn` (`zdrTurn.ts:30`)
   reads it per turn too, but a task is **durable and outlives the turn**. Whether the
   refusal is checked only at creation, or re-checked on every step (a user could flip
   `zdr` mid-task), is undecided. The plan assumes creation-only for v1; flagged because
   it is a privacy guarantee, not a nicety. **Not blocking, but should be an explicit
   test either way.**

(Answered while planning, hence not open: breach behaviour — `paused` + visible event +
resume-as-steering, settled under D6; ZDR policy — refusal, settled under D7; interrupt —
parked, D8. At planning time the ticket had no issue comments; it now carries two — the
binding #261 time contract and the loop-ownership spike decision recorded above.)

## Follow-ups

- Interrupt as a sequencing override (D8) — its own ticket after steering lands.
- Client affordances for resuming a budget-`paused` task (if the steering composer is not
  enough).
- A ZDR carve-out for tasks, if the owner ever decides tasks may be non-durable — a later
  owner decision, explicitly not this slice.
- Slice #253/#254-adjacent: task artifacts write provenance `kind: 'task'` + `taskId`
  into the #252 vocabulary; task-origin tasks may carry the originating session id.
