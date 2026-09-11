# Plan — feat/tv/16-web-search-tool (web search tool)

GitHub issue: https://github.com/alex-moon/tova/issues/16

## Motivation

The chat pipeline (`/api/chat/stream` → `routerService.routeQuery` → one Groq
completion) has no tool access and cannot answer questions that need fresh or
external information. Issue #16 asks for the first tool — web search — that the
eventual agentic loop from #4 will host. The issue proposes implementing it in
Mastra (see Open questions); the triage note said the ticket was blocked until
a search provider + key were chosen, and the owner's follow-up comment
unblocked it: use **Brave Search**, the API key is available in
`/opt/tova/.env` on the production host (ajmoon.com / 142.93.42.191) (the
key's exact value is NOT visible here — see Open questions on live
verification).

## Status check (confirmed from repo state, not just issue comments)

**Update after hardening pass (see "Hardening review" below):** as of the
review pass on this branch, steps 1–7 above are implemented and green; the
status notes below describe the state before that pass and are kept for
provenance.

- Working tree clean, branch `feat/tv/16-web-search-tool` at `d2009b1`
  (plan-doc commits only; no implementation commits).
- Full grep for `brave|webSearch|web_search` under `src/` (both server and
  client) returns nothing; `src/server/services/` contains no search-related
  module. The ticket is neither done nor started.
- #4 (agentic loop) is still open — no loop exists to wire into. Per the
  issue's own triage comment, the tool is built standalone and loop
  integration is deferred. **Decision: this does not block the core
  deliverable.**
- The original blocking reason (no key) is resolved per the owner's comment,
  and a Brave key is actually available in this environment
  (`BRAVE_SEARCH_API_KEY` in the env via the local `web-search` skill). The
  tool's "disable cleanly when unset" behavior still gets implemented and
  tested, because production keys can never be assumed present.

## Decisions so far

- **Provider: Brave Search** (owner's comment). REST API:
  `GET https://api.search.brave.com/res/v1/web/search`, auth header
  `X-Subscription-Token`. Docs verified against the local web-search skill;
  the endpoint shape is as documented.
- **Env var name: `BRAVE_API_KEY`** — read directly from `process.env` like
  `GROQ_API_KEY` in `src/server/services/inferenceService.ts` (pattern: no
  config framework; fall back to `'dummy_key'` so the SDK never throws locally
  — for Brave we will instead no-op when the key is unset). **However**:
  the local environment exposes the key under a _different_ name
  (`BRAVE_SEARCH_API_KEY`). Untangling which name the app reads, and whether
  the local `.env` should alias it, is now an Open question — no task below
  hard-codes the answer until it is resolved (validation code is written
  once the name settles; the service structure is name-agnostic).
- **Tool layer: hand-rolled, standalone** — a `webSearchService` module plus
  a typed tool definition. Mastra is deliberately not added (see Open
  questions). Rationale: no agentic loop exists yet to host it, one tool does
  not justify a framework, and #4 owns that decision.
- **Tool-calling path**: the Groq connector must pass a `tools` option
  through to `client.chat.completions.create`; the connector interface
  (`LlmConnector` in `inferenceService.ts`) currently takes arbitrary options
  so this should flow through unchanged — verified by reading the passed
  options, not assumed (see task 4). The plan runs a shallow, bounded
  decision loop inside the chat route/service: model may request the tool, we
  execute it, feed results back, small max-iteration budget. SSE status
  frames are emitted on the existing stream while the tool runs.
- **Persistence**: message count per turn stays 1 user + 1 assistant, as in
  the current code.

## Detailed steps

Each item is a single, self-contained commit:

1. **Add `BRAVE_API_KEY` to `.env.example`** with a comment noting it
   disables the tool when unset. One-line change. (If the variable-name
   open question resolves differently, adjust here first.)
2. **`webSearchService`** (`src/server/services/webSearchService.ts`):
   - `webSearch(query: string): Promise<SearchResult[]>` where
     `SearchResult = { title: string; snippet: string; url: string }`.
   - If `process.env.BRAVE_API_KEY` is unset/empty: return `[]` (never
     throw — callers treat it as "tool unavailable"). A unit test pins this
     clean-degradation behavior, since it is the issue's explicit acceptance
     path for keyless environments.
   - Real API call via global `fetch`; map Brave's
     `web.results[]` (`title`, `description`, `url`) to `SearchResult`;
     tolerate missing/extra fields (only tests can pin the exact response
     shape — see Open questions; code uses the documented shape but archiving
     a real response sample in the plan during step 6 is the double-check).
   - Timeout the fetch (e.g. `AbortSignal.timeout(10_000)`) and return `[]`
     on network failure with a `console.error` — a hung search must not hang
     the chat turn.
   - Unit tests with mocked fetch in the style of `routerService.test.ts`.
3. **Tool definition + synthesis helper**:
   - Groq `tools` entry for a `web_search` function: parameters `query`
     (string, required); optional `freshness` is dropped for now — nothing in
     the issue requires it and untested parameters are dead surface. If the
     live check (step 6) shows the model naturally benefits from a
     recency parameter, add it then as an explicit increment.
   - Result synthesis prompt: format results as a `[title](url): snippet`
     block and instruct the model to cite sources inline.
4. **Wire the bounded tool loop into the chat pipeline** (`chat.ts`,
   updating both the non-streaming and streaming paths):
   - Router service currently builds a completion without tools and does not
     return raw `tool_calls`; the loop must therefore interact with the
     connector _below_ the router's final answer, or replace one round trip.
     Concretely, the route makes: (a) an initial Groq completion with
     `tools` attached; (b) if `tool_calls` is present, execute each
     `web_search` call, emit the SSE status frame (streaming path), append
     tool results as `role: 'tool'` messages, and make a final completion
     that produces the user-visible answer. Cap at 1 search round (budget N
     = 1) for this ticket; deeper iteration is #4's territory.
   - Acceptance: if the model calls the tool, the assistant message content
     carries citations; `sources` (url list) is attached to assistant message
     data for future frontend rendering; message count per turn is unchanged.
   - Unit tests: mock the Groq client so a tool-call response and a
     tool-free response are both exercised through both route paths.
5. **SSE status events during tool runs** — emit a `status`-style frame
   while search executes so the UI can show "Searching the web…". Client
   `chat.stream.test.ts` (or its server-side equivalent) must still pass
   unchanged; if the existing SSE parser rejects new event types, fall back
   to `comment:` frames which every EventSource parser tolerates. Verify
   against the actual client-side SSE handling before shipping a new shape.
6. **Verify with the real key** — run a fresh-information question
   end-to-end locally (key confirmed available; see whether it needs an
   alias in local `.env` per the open question). In parallel, verify keyless
   degradation (unset var → tool no-ops, chat turn still completes).
7. **Final gate** — `npm run ci` green (server lint, format check,
   typecheck, tests, client lint/format/tests, client build).

## Open questions

- **(New, from the hardening review) Double completion cost on the streaming
  path**: the bounded loop always runs a non-streaming probe round with
  `tools` attached before streaming, so every streamed turn is two Groq
  round trips even when the model never searches. Acceptable now
  (budget = 1); if #4 replaces this loop, consider only probing for
  tool-capable models or letting the first round stream and detecting tool
  calls mid-stream.
- **(Resolved in code, still needs owner sign-off) Env var name**: code now
  reads `BRAVE_API_KEY` first and falls back to `BRAVE_SEARCH_API_KEY`
  (pinned by a unit test).
  Earlier: the issue says "implemented in Mastra", but the repo has no
  agentic loop yet and one tool does not justify a framework. The plan uses a
  plain typed module; if the loop from #4 lands with Mastra, adapt then.
  Posted to the issue as a question (see below). Not blocking on this
  ticket's own work, but it is a deviation from the issue's letter and needs
  the owner's acknowledgment — posted as a new comment.
- **Key variable name / live verification**: the local env exposes
  `BRAVE_SEARCH_API_KEY`; the plan and `.env.example` propose
  `BRAVE_API_KEY`. Which name does the app read? — posted as a new comment.
  Until answered, tasks are written to be name-agnostic in code behavior
  (fallback to empty → no-op) and rely only on whatever name step 1
  settles on. Item 6's local run depends on this resolution.
- **Which models support tool calling on the accounts in play**: the router
  may route a query to a model that does not support tools; the bounded loop
  would then never trigger even when useful. Whether to restrict tool-loop
  eligibility to certain routed models — needs a look at the router service
  and the actual model set during implementation; not yet answered.
- **Exact Brave response schema**: tests mock it, but the real shape of
  `web.results[]` fields is only fully pinned by a live call in step 6. If
  live verification is impossible (no key in a given environment), step 6
  degrades to "clean-degradation verified locally; live verify on deploy"
  — posted as a new comment.
- **Citations payload shape**: exact field name (`sources` on the assistant
  message) and rendering are future/floating work; #20 (shared client/server
  types) will want a say. — posted as a new comment.

## Honest assessment of assumptions

- "Groq connector accepts a `tools` option transparently" — likely, because
  `create` spreads options through, but unverified with a real call; task 4
  tests it explicitly before the loop lands.
- "The tool-calling model the router picks actually supports tools" — not
  checked; tracked as an open question rather than assumed (a route that
  picks a tool-less model would silently skip tool behavior, which is
  acceptable degradation but must be a _decision_, not an accident).
- "Adding Mastra later is cheap" — not verified; the adaptation cost if #4
  adopts Mastra is unknown but absorbed by that ticket, not this one.
- "Env key name" — genuinely uncertain; gated behind a posted question, no
  step hard-codes both names.
- "Client SSE parser tolerates new event types" — worse than it sounds to
  assume; plan already specifies a runtime check and a comment-frame
  fallback.

## Hardening review (critique of the branch as delivered)

Findings from the review pass against `origin/main..HEAD`:

1. **Delivery gap (found)**: commit `fd8052c` ("implement a deliverable")
   contained only steps 1–2 (`.env.example`, `webSearchService`, unit
   tests). The tool loop, SSE status event, and `sources` persistence —
   the issue's actual acceptance path — were missing; `webSearch` was dead
   code. All of steps 3–7 have now been implemented in-tree.
2. **Env name mismatch (was a silent-disable bug)**: the delivered service
   read only `BRAVE_API_KEY`, but the key in this environment is exposed as
   `BRAVE_SEARCH_API_KEY` — the tool would have been silently disabled.
   Fixed: both names are accepted; unit test pins the fallback.
3. **Breakability verified**: a route-level test (chat permissions) mocked
   the Groq client returning a raw streaming shape, and the initial
   implementation crashed on `first.choices[0]` when `choices` is absent.
   Fixed (`first.choices?.[0]`); the existing permissions test now locks
   this in.
4. **New tests added**: tool-round execution + `sources` persistence
   (non-streaming path), no-tool-call path (no `sources`, single completion),
   empty-search degradation, streaming path with `status` SSE event + exact
   `streaming-create` call assertions, service fallback env name, malformed
   JSON body handling, `global.fetch` teardown leak.
5. **Live verification (step 6) done**: a real call against the Brave API
   with the local key produced results in exactly the mapped shape
   (`title`/`description` on `web.results[]`), confirming the documented
   schema this repo's mapping assumes.
6. **Client SSE check (step 5) verified by reading the parser**: the client
   (`src/client/src/App.tsx`) splits on `\n\n`, finds `event:`/`data:`
   lines, and silently ignores unknown event types — the new `status`
   frame is safe (an in-UI "Searching the web…" hint remains future work
   for the frontend ticket rendering `sources`).
