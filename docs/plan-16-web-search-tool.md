# Plan — feat/tv/16-web-search-tool (web search tool)

GitHub issue: https://github.com/alex-moon/tova/issues/16

## Motivation

The chat pipeline (`/api/chat/stream` → `routerService.routeQuery` → one Groq
completion) has no tool access and cannot answer questions that need fresh or
external information. Issue #16 asks for the first tool — web search — that the
eventual agentic loop from #4 will host. The issue also proposes adding
Mastra as the tool layer; the triage on the issue noted the ticket was blocked
until a search provider + key were chosen, and the owner's follow-up comment
unblocked it: use **Brave Search**, `BRAVE_API_KEY` is available in
`/opt/tova/.env` on the production host (ajmoon.com / 142.93.42.191).

Confirmed from repo state (branch `feat/tv/16-web-search-tool`, working tree
clean at `71cf170`):

- No search/webSearch/tool code exists anywhere under `src/server` — the ticket
  is neither done nor started.
- #4 (agentic loop) is still OPEN, so there is no loop to wire into. Per the
  issue's own triage comment, the tool will be built standalone and loop
  integration is deferred; this does not block the core deliverable.

## Decisions so far

- **Provider: Brave Search** (owner's comment). Simple REST API at
  `https://api.search.brave.com/res/v1/web/search`, header `X-Subscription-Token`.
- **Env var: `BRAVE_API_KEY`**, read directly from `process.env` like the other
  keys in this repo (`GROQ_API_KEY` pattern in `inferenceService.ts:25`). No
  config framework is being introduced for this. When unset, the tool is a
  no-op/disabled and local dev and all existing tests keep working — this is
  the issue's "disabled cleanly when unset" requirement, and it is also what
  makes the missing local key non-blocking:
  *Verification of grounded answers with the real key happens against a
  deployment that has it (or locally once the key is placed in local `.env`).*
- **Tool layer: hand-rolled, standalone** — a `webSearchService` module +
  tool definition returning structured results. (See Open questions on Mastra:
  adding it just for one tool looks like overhead, since there is no loop yet
  to host it.)
- **Tool-calling path**: the Groq connector already returns
  `Groq.Chat.ChatCompletion`, which includes `tool_calls` support with a
  `tools` option. The plan is to run a shallow, bounded decision loop *inside
  the chat route/service* (model may request the tool; we execute it and feed
  results back; small max-iteration budget), independent of #4's larger loop.
  SSE status events (`event: status`-style frames on the existing stream) are
  emitted while the tool runs so the UI can show "Searching the web…".

## Checklist

Each item is a single, self-contained commit:

1. **Add `BRAVE_API_KEY` to `.env.example`** with a comment noting it disables
   the tool when unset. One-line change.
2. **`webSearchService`** — typed `webSearch(query, { freshness? })` calling
   Brave's REST API via fetch, returning `{ title, snippet, url }[]`; throws or
   returns empty when key unset. Unit tests with mocked fetch (match the Jest
   mocking style used in `routerService.test.ts`).
3. **Tool definition** — a typed schema (parameters: `query`, optional
   `freshness`) for the Groq `tools` option, plus a synthesis prompt helper
   that formats results as context for the main model.
4. **Wire the bounded tool loop into the chat pipeline** — the model may emit a
   `web_search` tool call; execute it, feed results back, cap at N iterations.
   Non-streaming and streaming paths in `src/server/routes/chat.ts` both go
   through it; citations/sources are carried in the assistant message payload
   for later frontend rendering; message count per turn stays 1 user + 1
   assistant.
5. **SSE status events during tool runs** — emit a status frame on the stream
   while search executes; test that the event is emitted and that the stream
   contract stays compatible with the client.
6. **Verify with a real key** — locally if/when `BRAVE_API_KEY` is placed in
   `.env`; run a fresh-information question end-to-end. Otherwise confirm
   clean-degradation behavior locally and note the manual verify for deploy.
7. **Final gate** — `npm run ci` green.

## Open questions

- **Mastra**: the issue says "implemented in Mastra", but the repo has no
  agentic loop yet and one tool does not obviously justify a framework. The
  plan above uses a plain typed module; if the loop from #4 lands with Mastra,
  adapt then. This is a minor implementation detail — flagged, not blocking.
- **Key value**: I do not have the contents of the production `.env`. If
  neither local verification (item 6) is possible, item 6 is done as
  "clean-degradation confirmed locally; live verify on deploy".
- **Streaming + tool calls interaction**: how exactly the bounded loop
  interleaves with the existing streaming SSE frames needs a careful look at
  `chat.stream.test.ts` expectations; if it forces a big refactor, fall back to
  tool support on the non-streaming path first.
- **Citations payload shape**: frontend rendering of sources is future work;
  exact field (e.g. `sources` on the assistant message) is a small contract
  decision, see also open issue #20 (shared client/server types).
