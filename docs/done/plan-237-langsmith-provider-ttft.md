# Plan — #237 LangSmith: provider attribution and TTFT under racing

## Motivation

Part of the #232 routing replacement (fixed roster + hedged provider racing).
Under racing, every turn fires two provider requests and aborts the loser. The
LangSmith trace must (a) attribute the winner to the right provider and (b) not
let the aborted loser pollute the per-model stats. TTFT also needs an owner:
runtime-recorded (the #232 weighted pick) or read back from traces.

Issue: [alex-moon/tova#237](https://github.com/alex-moon/tova/issues/237).
Base branch: `epic/roster` (see `docs/plan-roster.md`).

## Investigation (live traces, 2026-10-08)

Queried the `tova-dev` project via the `LANGCHAIN_*` REST creds
(`POST /api/v1/runs/query`). Findings, all against real runs:

1. **Provider IS in the trace.** Every `llm` run carries
   `extra.metadata.ls_provider` (`groq` / `deepinfra` / …) and
   `extra.metadata.ls_model_name`. The run *name* is model-only
   (`llm: '<model>'`), but the provider is on the metadata the entire time.
   The old contract comment ("LangSmith llm runs do not reliably carry the
   provider") is **wrong** for this exporter. Root cause: the provider is a
   MODEL_GENERATION span attribute and `@mastra/langsmith` maps it to
   `ls_provider` (`node_modules/@mastra/langsmith/dist/index.js:279-282`,
   source attribute set in `@mastra/core/dist/model-C1q1GlNE.js:106`).
   → **OQ1 answered: provider attribution is available, no export change needed.**
2. **TTFT IS in the trace.** Runs expose a first-class `first_token_time`
   (and a matching `new_token` event). `first_token_time - start_time` is the
   TTFT. → **OQ3 answered: traces can corroborate (and display) TTFT.**
3. **No error/aborted `llm` runs observed** in the project (racing is not live
   in prod yet; traces are tier-era). The exporter aborts spans only on the
   trace memory cap / shutdown (`@mastra/observability`); a per-call abort
   surfaces as an errored llm run. → **OQ2: cannot observe live; design
   defensively** (below).

## Decisions

1. **Provider identity: read, do not re-export.** The provider already reaches
   traces as `extra.metadata.ls_provider`; `langsmithTracesService` parses it
   (`providerFromRun`) and carries `provider` on trace rows, trace-detail runs,
   and stats rows. No change to `mastraService` tracing is needed for
   attribution. (Avoid churn: the data is already there.)
2. **Stats rollup keyed by `(model, provider)`.** `traceStats` groups by both,
   resolving the #235 follow-up (the model-only fallback misprices a dual-priced
   model). Contract, `TraceStatsCache` schema, and the admin table gain
   `provider`. Cache rows from before this change have no provider → treated as
   unknown (model-only fallback), same as legacy.
3. **Aborted loser is filtered, not counted.** A raced provider call whose
   llm run failed with an abort/cancel signature (`isClientAbort`-style:
   `AbortError`/`CanceledError`/message match) is excluded from `calls`,
   `errors`, and `avgDurationMs` — it never served the user. Non-abort errors
   are still counted. This is the honest reading of a race.
4. **Tag the race.** `racingService` attaches trace metadata/tags
   (`race: 'roster'`, `provider:<name>`) to each provider call, so racing is
   debuggable in the LangSmith UI. The winner is *not* tagged at start — the
   span is created before either racer wins, so neither can be marked up front;
   the loser is identified by its abort/cancel error and filtered from stats.
   Tagging is observability only, never a routing input.
5. **TTFT source: runtime is authoritative; traces corroborate.** The weighted
   pick keeps using the runtime-recorded TTFT (`rosterConfig.recordTtft`,
   #232). The admin stats additionally display per-`(model, provider)`
   `first_token_time - start_time` so a human can eyeball the runtime figure
   against LangSmith. Traces are read-only and never feed the pick.
6. **OQ4 (split per provider in admin): yes.** The stats table becomes
   per-provider, which is the point of (2).

## Done

- [x] Investigation recorded above (provider visibility, TTFT, loser).
- [x] `langsmithTracesService`: parse `ls_provider`; add `provider` to rows,
      detail runs, and stats; add per-row `avgTtftMs`; filter aborted losers.
- [x] `traceStats`: roll up by `(model, provider)`.
- [x] `racingService`: tag raced provider calls with race metadata.
- [x] Contracts + `TraceStatsCache` + admin route/UI carry `provider`/TTFT.
- [x] Tests updated/added; `npm run ci` green (86 server suites / 1062 tests).

## Follow-ups

- The #235 price join can now use the trace's provider directly (the fallback
  stays for legacy no-provider rows).
- Fireworks runs are not in the project yet; when racing goes live, confirm
  `ls_provider` reads `fireworks-ai` (Mastra router id) and map it to the
  roster provider name `fireworks` in `providerFromRun`.
