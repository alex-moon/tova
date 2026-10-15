# Plan — #308 Workspace facts in the admin traces view

Show, per trace in the admin Traces tab, (a) how the workspace guard voted and
(b) whether workspace retrieval surfaced anything. Delivered alongside a fix to
the tracing plumbing the issue exposed.

## Findings that shaped the design

- **Mastra drops call-level `metadata`/`tags`.** `traceOptionsFrom` passed them
  top-level on generate/stream options; only `tracingOptions` reaches spans
  (verified live: `raceTrace`'s `race`/`provider` keys and tags are absent from
  every run, while the `tracingOptions`-borne `session_id` lands). Mastra 1.66
  `TracingOptions` carries `metadata`/`tags` — they belong inside it.
- **Threads key on run metadata.** LangSmith groups Threads by
  `metadata.session_id`/`thread_id` (docs). Chat legs carry it (both race legs
  share the chat session id — the hedge explains `tova-groq` vs
  `tova-deepinfra` root names); the aux calls (title, metrics, enrichment,
  followups) carry no sessionId and are invisible to Threads. Old threads stay
  orphaned — owner ruling: forward-only, no backfill.

## Tasks

1. **Plumbing** (`mastraService.traceOptionsFrom`): pass `metadata`/`tags`
   through `tracingOptions` (merged with the `withLangsmithMetadata` updater).
   `raceTrace`'s tags start landing as a consequence.
2. **Votes enrichment** (`enrichmentService`): `EnrichmentVotes` gains optional
   `timedOut`; the timeout path marks it instead of collapsing silently. Aux
   call rides `sessionId` when the caller has one (threads the guard run).
   Export `workspaceGateFrom(votes, skip)` + `workspaceTraceMetadata(gate,
   block)` helpers (keys `tova_workspace_gate`: yes/no/timeout/off,
   `tova_workspace_hits`: rendered slice count).
3. **Routes** (`chat.ts`): thread sessionId into `enrichmentBlocksFor`; attach
   the workspace metadata to the main call's `trace` on both routes. ZDR turns
   stay untraced (unchanged). Title stays unthreaded — it runs pre-session by
   construction. Metrics + followups get sessionId threaded.
4. **Surface** (`langsmithTracesService` + contracts): add `extra` to the roots
   select; `toTraceRow` reads the two keys (defensively typed); `AdminTraceRow`
   gains optional `workspaceGate`/`workspaceHits` (absent = pre-#308 trace).
5. **View** (`AdminLangsmithView`): a Memory column (`yes · 3` / `no` /
   `timeout` / `off` / `—`) using the existing `responsive-table`/`data-label`
   mobile pattern.

## Decisions

- Facts ride the **main** run (the route knows votes + block before the model
  call; the aux call's own tags cannot carry its result). The list view reads
  the root run it already fetches — no extra LangSmith round-trip.
- `off` is distinguishable from `no` (kill switch / image turn / memory
  disabled); `timeout` marks the silent Groq-slowness case that motivated the
  diagnosis.
- Namespaced flat metadata keys (identifier-only values, no user content) —
  consistent with the `TraceContext.metadata` contract.

## Verification

- Unit: enrichment timedOut/sessionId, route metadata assertions, traces join
  (present/absent/legacy), view column. `npm run ci` green.
- Live smoke: one local chat turn → metadata keys visible in LangSmith; aux
  runs appear under the session's thread.
- Playwright at 375px: the traces table stays within the viewport
  (`responsive-table` card mode).
