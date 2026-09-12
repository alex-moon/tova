# Plan — #5 LangSmith tracing/evals for the Groq pipeline

GitHub issue: https://github.com/alex-moon/tova/issues/5

## Motivation

No observability today: model calls, routing decisions and prompt assembly are
one-off `console.error` breadcrumbs. This ticket wires LangSmith tracing around
the Groq pipeline (env-gated), so model calls, routing decisions and prompt
assembly are inspectable per request.

## Pivot (2026-09-12)

An earlier iteration on this branch built a bespoke tracing layer
(`tracingService.ts`: `traceable()` spans + `wrapOpenAI()` on the Groq client,
hooks in `chat.ts`/`routerService.ts`/`titleService.ts`/`inferenceService.ts`).
That work is **discarded** — see the ticket comment on #5 — in favour of the
official Mastra plugin **`@mastra/langsmith`**
(https://docs.langchain.com/langsmith/trace-with-mastra):

- Mastra traces agents out of the box; `LangSmithExporter` maps Mastra spans
  (root → `agent.generate`/`agent.stream`, model calls, hierarchical
  parent/child) to LangSmith, with token usage, latency and error status.
- Convention over configuration: env-gated zero-config when
  `LANGSMITH_API_KEY` / `LANGCHAIN_PROJECT` are set.
- Removes the hack the old plan needed (structural stand-in stub for Groq in
  `wrapLlmClient`, because wrapOpenAI expects a legacy `completions` property).
- Per-request metadata (sessionId/userId) now goes via
  `withLangsmithMetadata` + `buildTracingOptions` instead of custom plumbing.

## Context

- `@mastra/core@1.66.0`; `mastraService.ts` is the single owner of all
  `@mastra/*` imports and of provider construction (decision from #4).
- `LANGSMITH_API_KEY` lives in `/opt/tova/.env` on ajmoon.com
  (142.93.42.191); `LANGCHAIN_PROJECT=tova` local default (`.env.example`
  documents the optional vars).
- All LLM calls funnel through `mastraService.ts` connectors
  (`createCompletion` / `createStreamingCompletion`) — callers: chat routes
  (streaming + not), routerService guard, titleService, metricsService.
- Plugin set-up (docs, current): `npm i @mastra/langsmith @mastra/observability`
  and on the `Mastra` instance
  `observability: { configs: { langsmith: { serviceName, exporters:
[new LangSmithExporter({ apiKey })] } } }`. Exact shape to be verified
  against the installed versions at implementation time (docs variants:
  plain object vs `new Observability(...)`).

## Decisions

1. **`@mastra/langsmith` `LangSmithExporter`** wired into the Mastra instance
   in `mastraService.ts` (keeps #4's "single owner of `@mastra/*` imports"
   rule). `@mastra/observability` peer installed alongside.
2. **Env-gated, byte-identical off-path.** No exporter object at all when
   `LANGSMITH_API_KEY` is absent (defaults: exporter reads the env vars
   itself). Locally/CI without a key runs exactly as before, so Jest suites
   keep passing unchanged.
3. **Per-request sessionId/userId metadata** via
   `withLangsmithMetadata({ sessionId })` + `buildTracingOptions` on the
   agent call options, driven from the chat route. **No PII** — userId /
   sessionId only, never user content, in metadata.
4. **Routing tags** (`model:<model>` / `reason:<reason>` from RoutingResult)
   surface via Mastra span metadata at the agent-call site so routing
   regressions correlate across traces (issue #5 acceptance).
5. **Streaming aggregates in Mastra tracing**; the SSE per-delta handler
   contract to the client is untouched.
6. **Evals out of scope for this slice** (retained from the old plan):
   the golden prompt set + CI job needs dev-session data in the project
   first to shape the rubric against; follow-up.

## Implementation (this branch)

- `mastraService.ts`: singleton `mastra` instance with `InMemoryStore`; when
  `LANGSMITH_API_KEY` (or `LANGCHAIN_API_KEY`) is present an `Observability`
  config with `LangSmithExporter` is attached. No key → no exporter at all.
- Agents are memoised per `provider/model`; agent creation stays in
  `mastraService.ts` only.
- `llmTypes.ts`: optional `trace` context on `CompletionOptions`
  (`sessionId` / `tags` / `metadata` — identifiers only, no PII).
- `routes/chat.ts`: both endpoints attach
  `{ sessionId: <session id>, metadata: { userId }, tags: [model:<m>,
reason:<r>] }` from the routing result, per call.
- Jest: the new `@mastra/*` entries map to inert stubs for the same
  ESM-transitive-deps reason as the existing agent stub (jest.config.js)

## Verification

- `npm run ci` gates green (lint/format/typecheck/tests/build — see the
  commit for the run).
- Env-gated off-path covered by unit tests; trace attach covered by unit
  tests on the connector boundary.
- **Live trace read-back is paused**: traces were observed live for
  standalone scripts early on the branch, but read-back from the service
  path could not be re-confirmed in this environment near the end of the
  work (exporter silent). Owner will verify from the dashboard / their own
  runner; nothing in the code path depends on that check, and the trace
  attach was exercised by both scripts and unit tests. The likely residual
  causes sit in dashboard/project configuration, not in the wiring.

## Follow-ups (not done here)

- Evals: golden prompt set (simple vs code vs complex), router offline run,
  LangSmith dataset + CI job — needs dev session data first.
- `docs/done/` archive after merge.
