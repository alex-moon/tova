# Plan — #145 Log redaction + structured logging evaluation

Status: in flight (branch `feat/145-log-redaction`, PR #154).

This is the gate ticket for the RAG landing-seam notes work: `docs/overview.md`
can only state a no-leak constraint honestly once redaction exists before every
log emission.

## Short term (done)

- `src/server/services/logRedaction.ts`: `redactForLog()` takes an unknown
  value and returns a string safe for `console.error` — message text redacted,
  error shape (name, stack frames, status/class tokens) kept.
- Verified leak-adjacent call sites wired: `routes/chat.ts` (ephemeral-asset
  cleanup, chat error, streaming error, entity extraction/retrieval, prompt
  classification) and `middleware/requestLog.ts` (audit confirmed it logs only
  method/path/status/latency — no user content, no redaction needed).

## Redaction policy (note)

Conservative heuristic: quoted payload text (>= 16 chars), JSON-esque blocks
(>= 40 chars), secret-shaped assignments (`apikey=`, `bearer`, ...), and any
remaining 64+ char run. Deliberately aggressive — over-redaction is the
conservative direction for a no-leak constraint. Open question: short personal
content ("< 16 chars") can survive; treated as acceptable given the emission
sites are error paths, not content mirrors.

## Audit (scope 2)

`rg -n 'console\.' src/server` reviewed hit by hit:

- Redacted: chat.ts (5 sites), routerService.ts, titleService.ts,
  followupService.ts, metricsService.ts, webSearchService.ts,
  safeLinkService.ts, entityExtractionService.ts, geoLocationService.ts,
  assets.ts, feedback.ts, auth.ts, index.ts, config/jwt.ts.
- Not user content (no change): logService internals and its test,
  logRedaction internals, modelConfigService / modelMetricsStatsService
  (config only), mcpService (warn path reviewed, no user text).

### LangSmith trace-payload check

`@mastra/langsmith`'s `LangSmithExporter` posts `span.input` / `span.output`
/ `span.errorInfo` verbatim to the LangSmith project — with a dev trace key
set, prompt content reaches the trace store. Fix (this branch):
`src/server/services/traceRedaction.ts` adds `RedactedLangSmithExporter`,
which overrides the exporter's `_preExportTracingEvent` hook and runs the
same redaction policy over span input/output/error payloads (depth- and
width-capped deep walk). Wired as the sole exporter in `mastraService.ts`.

## Structured logging (scope 3, evaluated)

Decision: **keep console + the logService buffer; do not adopt pino now.**

Why:

- The leak surface is not formatting but emission and transport: we need every
  user-content-adjacent arg list to pass through `redactForLog()`. Pino's redact
  hooks compose on JSON paths (`req.headers.authorization`) and do not catch
  arbitrary narrative text embedded in error messages — which is the actual
  failure mode here. That means we would need a custom transport-level
  rewriter anyway; the same wrapper logic, but around a bigger, noisier
  interface migration.
- All emission sites (file + admin buffer via `logService.attachConsoleCapture`)
  already see unified output. Redacting at the call site — the one place the
  value exists before it fans out — is a smaller surface than redact-at-transport
  because logs cannot reach anywhere that misses it.
- Migration cost vs benefit: pino would buy level-awareness, ring buffer, and
  request-id threading for a single-process server; the admin logs view already
  delivers level filtering and buffering.

Revisit trigger: if the server goes multi-instance / ships structured logs to
a remote collection service, re-evaluate pino with a redaction pre-commit in
the transport.

## Gate

Once this lands, the RAG landing-seam notes ticket can state: all log emission
(console and trace transport) passes shared redaction.
