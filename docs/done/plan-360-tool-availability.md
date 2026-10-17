# Plan 360 — tool availability & context assembly

## Motivation

#360: `list_files` appeared absent from the agent's tool set in some sessions. Investigation
(ticket comments, 2026-10-17) established, from traces + the synced DB:

- **Tool registration is deterministic.** Traces for both sessions show `list_files` in
  `availableTools` on every main-model span; the tool literal is baked per agent
  (`mastraService.ts` `agentFor()`), conditioned on nothing per-session.
- Both ticket sessions belong to `formsatz@gmail.com` (an earlier comment claimed different
  users — corrected on the ticket after re-identifying the sessions in the synced DB).
- The user-visible failure is **behaviour, not registration**: the model narrated listings
  ("I described a listing… No — and that's the honest answer. I didn't [use the tool]") with
  zero `tool_call` spans, twice in a row, while `list_files` was registered throughout. With a
  fixed 10-message window and tool results unpersisted, every retry saw the same starved
  context and kept narrating.

Fix direction: use the 1M-token context windows both roster models have (deep history), make
earlier tool work visible as provenance, and stop connector toolsets from crowding the primary
tool surface (deferred loading per the current standard: Anthropic Tool Search Tool /
Claude-Code MCP tool search; Mastra-native implementation is `ToolSearchProcessor`).

## Decisions

1. **Connector tools defer to search; built-ins always loaded.** Agent `tools` (the 9 built-ins)
   stay attached directly and always in-prompt. Per-user MCP connector toolsets still resolve
   per request (`connectorToolsetsForUser`, TTL cache unchanged) but are no longer passed as
   `toolsets`; instead each call builds a `ToolSearchProcessor`
   (`@mastra/core/processors`, present in 1.66.0) whose **static catalog** is that user's
   resolved connector tools, with `search: { topK: 5, autoLoad: true }` (single search step).
   Built per call so per-user credentials and loaded state never cross calls or users.
   - `includeResolvedTools: true` was rejected: `requestResolvedTools` in Mastra's
     `convertTools` includes the agent's own `tools`, so it would defer the built-ins too —
     violating the "primary always visible" requirement.
   - Catalog tools are re-wrapped with sanitized ids (function names must be provider-safe;
     MCP toolset ids carry a `setKey/` prefix).
   - Verified live (local stack + a throwaway MCP server + formsatz's synced session):
     step-0 `availableTools` becomes `[search_tools, …9 built-ins]`; a natural-language ask
     runs `search_tools` → autoLoad → the MCP tool executes (`ECHO: wired correctly`).
2. **No fuzzy tool suggestion existed to remove.** Verified: connector toolsets attached
   wholesale; workspace retrieval surfaces assets, not tools; the retrieval-vote gate was
   retired in #310. The processor replaces implicit all-or-nothing attachment with the
   standard discovery flow.
3. **Deep history window.** `windowedHistory` (chat.ts): newest-kept, oldest dropped first,
   `HISTORY_MAX_MESSAGES = 200` and `HISTORY_MAX_CHARS = 400_000` (~100k tokens, a rounding
   error against the 1,048,576-token roster windows). The DB query fetches the newest 200 and
   the helper trims by chars; the 413/failover path catches pathological outliers. The roster
   is uniform at 1M windows; if it ever diversifies, rescale then.
   No automated compaction in scope: no realistic session overflows the budget. Deliberately
   no compaction ticket created.
4. **Tool provenance in prompt history.** Persisted `Message.tools` chips (from #196) render as
   a compact factual line (`[tools used: list_files, read_file ×2]`) on assistant turns at
   prompt-assembly time (`toolProvenanceLine`) — no migration, no double persistence. The
   non-streaming route now persists chips too (it previously dropped them, which would have
   made provenance one-sided).
5. **`search_tools` chip handling.** Label "Searched connected tools"; added to
   `NON_CONFIRMING_TOOLS` so a discovery-only turn doesn't synthesize a task confirmation.
   MCP connector tools render as their raw names (as before).

## Done

- [x] Probe findings + corrections posted to #360 (traces + DB diff; corrected session identity).
- [x] `ToolSearchProcessor` wired: built-ins always loaded, connector toolsets deferred,
      verified live end-to-end (discovery + execution through a real MCP server).
- [x] Deep history window in both chat routes.
- [x] Tool provenance rendered into prompt history; chips persisted on the non-streaming route.
- [x] Tests: `mastraConnectorSearch.test.ts` (option shape, id sanitization, collision rule),
      `chat.stream.test.ts` (window caps, provenance rendering); `npm run ci` green.

## Follow-ups

- #366 — capability surfacing (the second-order invisibility issue; split out of #360 by its
  own note).
- Watch traces for `search_tools` frequency: loaded-tool state is per-call (re-discovery each
  turn is the standard cost; Claude Code re-searches after compaction). If traces show spam,
  a session-scoped store (`MASTRA_THREAD_ID_KEY` + shared processor) is the next move —
  evidence first, no ticket yet.
- Suggestion raised on the PR, not fixed here: `RosterModel.tools` is dead config (stored and
  exposed but consumed nowhere in the request path).
