# Plan — feat/tv/16-search-mastra (web search tool, Mastra-native)

GitHub issue: https://github.com/alex-moon/tova/issues/16

**State: implemented, `npm run ci` green.** Supersedes the closed-out
`docs/plan-16-web-search-tool.md` (PR #24): the owner confirmed starting
offline from a **fresh branch off current main** (`feat/tv/16-search-mastra`),
because main has since grown the Mastra agentic stack (#4/#29) and LangSmith
tracing (#5/#25), which made the old branch's hand-rolled Groq `tools` loop a
dead end.

## Why a rewrite, not a merge

Resolving PR #24's conflicts with main would have meant bolting a `tools`
option onto the neutral connector types and keeping a second, parallel tool
loop next to Mastra's own — exactly what the issue letter warned against
("implemented in Mastra"). The reusable salvage from #24 is small:

- `webSearchService` (raw Brave REST client, key-unset degradation to `[]`,
  10s timeout, blank-query quota guard) — dropped in unchanged
- `sources: string[]` provenance field on `Message` — re-added next to
  `routingBand`/`feedback`
- `BRAVE_SEARCH_API_KEY=` in `.env.example` — re-added
- the SSE `status` event contract and the "hint must cover the whole search"
  timing lesson

## Architecture (owner-confirmed direction)

The agent decides whether to search; most turns never reach the tool.

1. **Tool definition** (`mastraService.ts`): `web_search` via
   `createTool` (`@mastra/core/tools`). Input zod `{ query }`, output
   `{ results: { title, snippet, url }[] }`. `execute` delegates to
   `webSearchService.webSearch`, which never throws. The tool lives in
   `mastraService.ts` because that file is the single owner of all
   `@mastra/*` imports in this repo.
2. **Attachment is env-gated**: with neither `BRAVE_API_KEY` nor
   `BRAVE_SEARCH_API_KEY` set, no tool is attached at all — plain chat is
   byte-identical to pre-#16 (maxSteps stays 1).
3. **Agent-hosted loop**: `maxSteps: 4` when the tool is attached. There is
   no probe round and no route-level loop budget; Mastra runs the
   search → answer (and one retry/refine) cycle itself.
4. **System instructions**: a short `SEARCH_INSTRUCTIONS` is set on the
   agents only in tools mode (write keyword queries; answer as
   `[title](url)` markdown links; answer from own knowledge otherwise).
   The agent cache key includes the tools state so tests toggling the key
   don't poison memoised agents.
5. **Neutral boundary** (`llmTypes.ts`): tool facts cross the connector as
   neutral shapes — `NeutralStreamChunk.toolCall` / `.toolResult` (streamed
   pass-through of Mastra's `tool-call`/`tool-result` fullStream chunks) and
   `NeutralCompletion.toolResults` (from Mastra `FullOutput.toolResults`).
   Callers never see Mastra shapes.
6. **Routes** (`chat.ts`): first streamed `toolCall` emits the SSE `status`
   frame (`Searching the web…`) exactly once per turn, before the search
   executes. `toolResult` URLs are collected incrementally deduplicated and
   persisted as assistant-message `sources` only when non-empty.
   Non-streaming path does the same off `toolResults`.

## Known-doubt assumptions

- `FullOutput.toolResults` and fullStream `tool-call`/`tool-result` shapes
  were verified against `@mastra/core@1.66.0` type definitions (this pass);
  real-network behaviour of the agent actually calling the tool through
  `maxSteps > 1` is not exercised live yet.
- Zod is a transitive dep of `@mastra/core` (used as a direct import);
  promote it to a direct dependency if the package manager complains later.
- Client still ignores `status` frames and does not render `sources` yet;
  failure auditing/DB audit and UI visibility of failed tool calls remain
  follow-ups (same as the old plan's open questions).

## Tests

- `mastraService.test.ts` pinned to plain mode (the test host exports a
  Brave key) plus a new tools-mode block: tool/instructions attachment,
  `maxSteps > 1`, `toolResults` surfacing, tool chunk mapping.
- `webSearchService.test.ts`: unchanged shame (mocked `global.fetch`,
  degradation matrix).
- Route tests: deduped `sources` persisted + omitted on tool-free turns
  (both paths), single `status` frame, classifier-vs-chat `generate` calls
  gated on prompt shape.
- `jest.config.js` maps `@mastra/core/tools` to a new TS stub
  (`mastraToolsStub.ts`) for the same ESM-in-ts-jest reason as the other
  `@mastra/*` stubs.
