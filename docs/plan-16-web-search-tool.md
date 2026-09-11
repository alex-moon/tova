# Plan — feat/tv/16-web-search-tool (web search tool)

GitHub issue: https://github.com/alex-moon/tova/issues/16

**State: implemented and hardening-reviewed on this branch.** All steps below
are done in-tree (see "Status check" and "Hardening review"); what remains is
the list in "Remaining work", plus the Open questions.

## Motivation

The chat pipeline (`/api/chat/stream` → `routerService.routeQuery` → one Groq
completion) had no tool access and could not answer questions needing fresh or
external information. Issue #16 asks for the first tool — web search — that
the eventual agentic loop from #4 will host. The issue proposed implementing
it in Mastra; the triage note said the ticket was blocked until a search
provider + key were chosen. Both are resolved by the owner's comments (see
"Decisions resolved by issue comments").

## Status check (confirmed from repo state, not just issue comments)

- Working tree clean, branch `feat/tv/16-web-search-tool` currently at
  `fb8a208`. `npm run ci` (server lint, format, typecheck, tests, client
  lint/format/tests, client build) is green as of today.
- Implementation is present in-tree, verified by reading the files, not
  comments: `src/server/services/webSearchService.ts` (Brave REST call,
  clean degradation to `[]` when the key is unset, 10s timeout, tests in
  `webSearchService.test.ts`), `src/server/services/toolLoopService.ts`
  (`runSearchStage` — one bounded search round), wiring in both paths of
  `src/server/routes/chat.ts`, `sources` persistence in
  `src/server/models/Message.ts`, plus route tests in `chat.test.ts` /
  `chat.stream.test.ts`.
- Set-up secrets: local `.env` holds a working key under
  `BRAVE_SEARCH_API_KEY` (live call against the real Brave API succeeded —
  see Hardening review item 5). `.env.example` now lists
  `BRAVE_SEARCH_API_KEY=` with an empty value (fixed to the owner-chosen
  canonical name).
- #4 (agentic loop) is still open — the tool therefore lives in a shallow
  standalone loop here, per the owner's comment "fold this into Mastra as
  part of work on #4". Not a blocker for this ticket.
- The branch is **behind `origin/main`** by at least the merges for
  #21/#28 (e.g. main now has `src/shared/contracts.ts`, this branch does
  not). CI is green on the branch in isolation, but the eventual PR must be
  rebased onto / merged with current main first — see Remaining work.

## Decisions resolved by issue comments (moved out of Open questions)

- **Provider: Brave Search**, key available in `/opt/tova/.env` on the
  production host (ajmoon.com / 142.93.42.191). Resolved the original
  triage-blocked state.
- **Mastra**: the issue letter says "implemented in Mastra". Owner's answer:
  "fold this into Mastra as part of work on #4". So this branch ships a plain
  typed module + a shallow bounded loop, and #4 hosts the eventual Mastra
  rewrite. Deviation acknowledged by the owner.
- **Env var name**: owner confirmed `BRAVE_SEARCH_API_KEY` as the correct
  canonical name (Brave has per-service keys). Code therefore dual-reads
  `BRAVE_API_KEY` first, falling back to `BRAVE_SEARCH_API_KEY` (pinned by a
  unit test). The deprecated `BRAVE_API_KEY` name is read for forward
  compatibility with `.env.example` copies that browsers may have made
  before the rename; `.env.example` now shows only `BRAVE_SEARCH_API_KEY=`.
  Owner said they will update ajmoon.com's `.env` themselves.
- **Model eligibility**: owner confirmed acceptable degradation is fine —
  if the router picks a tool-less model, the probe round with `tools`
  attached still works (Groq simply never returns `tool_calls`) and the tool
  silently doesn't trigger. A broader tool-calling/routing metric strategy is
  explicitly deferred ("make the tool-calling properly agentic … elsewhere").
- **Probe-for-all (double round-trip cost)**: owner confirmed the
  non-streaming probe round with `tools` attached on every streamed turn is
  not only acceptable but "what we want to prove with this app" — Groq's
  speed should hide agentic work; the real lag is expected so its feel can
  be observed. This was the last open question on that topic; the loop does
  the full probe for all responses.
- **Live verification of Brave schema**: done. A real call with the local
  key returned `web.results[]` entries mapping exactly as assumed
  (`title`, `description`, `url`). The fallback plan for key-less
  environments ("clean degradation verified locally; live verify on deploy")
  is no longer needed for this branch.

## Remaining work (post-hardening)

- **Fresh key per owner's instruction**: owner asked that the local `.env`
  value be overwritten with the key on ajmoon.com. The key currently in
  local `.env` verifies live against the real Brave API, so it is _a_ valid
  key; whether it is byte-identical to the production one cannot be checked
  from this environment (no access to ajmoon.com's filesystem beyond the
  owner's word). Not pursuing: any valid Brave key satisfies the tool.
  If production uses a different key with different quotas, that is a
  deploy-time concern, not a code one.
- **Rebase/merge onto current `origin/main`** before opening the PR (main
  has since merged #21/#28; `src/shared/contracts.ts` exists on main and
  not here). Do not assume a green branch in isolation implies a clean PR
  tree once merged.
- **`.env.example` rename** to `BRAVE_SEARCH_API_KEY=` — done in this
  revision pass (one-line tweak per owner's comment, no commit here).
- **Final gate re-run** once the branch is synced with main — `npm run ci`
  (and the frontend build) must stay green after the merge.

## Detailed steps (as delivered; kept for provenance)

Each item was one self-contained commit:

1. **`BRAVE_SEARCH_API_KEY` in `.env.example`** with a comment noting the
   tool disables cleanly when unset.
2. **`webSearchService`** (`src/server/services/webSearchService.ts`):
   - `webSearch(query: string): Promise<SearchResult[]>`,
     `SearchResult = { title: string; snippet: string; url: string }`.
   - Key unset/empty → return `[]`, never throw. Unit-tested.
   - Real API call via global `fetch` against
     `https://api.search.brave.com/res/v1/web/search` with header
     `X-Subscription-Token`; maps Brave `web.results[]`
     (`title`/`description`/`url`) to `SearchResult`; tolerates missing
     fields.
   - `AbortSignal.timeout(10_000)`; network failure → `[]` + `console.error`
     (a hung search must not hang the chat turn).
   - Unit tests with mocked fetch in the style of `routerService.test.ts`,
     including the fallback env-name test.
3. **Tool definition**: `web_search` function with only `query` (required);
   `freshness` dropped — nothing in the issue requires it and untested
   parameters are dead surface (owner confirmed acceptable degradation
   policy leaves headroom for adding knobs later).
4. **Bounded tool loop** (`toolLoopService.runSearchStage`, wired into both
   paths of `chat.ts`): (a) non-streaming probe completion with `tools`
   attached (owner-approved for all responses); (b) if `tool_calls` is
   present, execute each `web_search`, emit the SSE `status` frame on the
   streaming path, append `role: 'tool'` messages, final completion produces
   the answer. Unknown tool names get a "Unknown tool: …" tool message rather
   than crashing. Budget = 1 search round; deeper iteration is #4's.
   Unknown/non-`web_search` tool calls are answered-as-unavailable rather
   than retried — deliberate, not accidental.
   - Acceptance met: the assistant message carries inline citations when a
     search happened; `sources: string[]` (URLs) is attached to the assistant
     message data (`Message.ts`), only when non-empty; message count per turn
     unchanged (1 user + 1 assistant).
   - Tests: tool-call and tool-free responses exercised through both route
     paths, plus malformed-JSON-arguments handling and `global.fetch`
     teardown-leak hygiene.
5. **SSE `status` event** while search executes. Verified against the actual
   client parser (`src/client/src/App.tsx`): it splits on `\n\n`, finds
   `event:`/`data:` lines, and silently ignores unknown event types — so the
   `status` frame is safe. No UI hint is rendered yet (see Remaining work /
   open questions on failure visibility).
6. **Live verification**: real call against Brave with the local key,
   results matched the mapped shape exactly. Keyless degradation tested via
   unit test (no live chat needed past that, since `[]`-results path is also
   unit-locked).
7. **`npm run ci` green**, then again after syncing with main.

## Remaining honesty about assumptions (those now in doubt moved to Open questions)

- **Model actually emitted well-formed tool_calls** — verified only in tests
  with mocked Groq responses; live behavior is untested in this repo.
  Risk exists that the model returns malformed `arguments` JSON; that is
  already tolerated (fallback to raw string as query — the empty/odd query
  simply yields an empty result set). Accepted.
- **Non-streaming probe round hides streaming latency benefits** — owner
  explicitly rejected worrying about this for now; recorded so it isn't
  re-litigated.
- **`tool_calls` tolerance `first.choices?.[0]`** — verified breakable via
  route tests and fixed; test locks it in.
- **`sources: string[]` (URLs only, no titles)** — implemented this way
  because the tool result synthesis carries titles/markdown inline; whether
  #20 wants richer payloads (title+url pairs) belongs to that ticket.
- **Brave API shape drift** — pinned only by the one live call recorded in
  the hardening pass; no contract test against a frozen fixture exists.
  Acceptable since the mapping tolerates missing fields.
- **"Groq connector accepts a `tools` option transparently"** — was risked
  in the first pass, then actually verified by exact call-shape assertions in
  the streaming route tests (`streaming-create` call assertions).

## Open questions

- **Failure auditing + UI visibility of failed tool calls** (NEW — posted to
  the issue): the owner asked that unreachable Brave API calls "register as
  a failed tool call (and ideally audited somewhere in the DB! … ideally
  failed tool calls should be visible in the chat UI", deferring the how to
  my judgment or a new ticket. Current implementation: `webSearch` degrades
  failed/timed-out calls to a normal empty result set (indistinguishable
  from "no results") and the client parser ignores `status` frames, so
  _neither_ a DB audit record nor in-UI surfacing of the failure exists
  today. The plan (and code) will punt this to a follow-up ticket unless the
  owner objects — no task above depends on this answer.
- **Unconfirmed acceptance of the sources contract** (carried over; owner
  asked a counter-question rather than accepting): the counter-question
  "sources? Like as in tool calls?" is answered in the new issue comment
  (sources are NOT tool-call records — they are provenance URL strings
  extracted from search results, attached to the assistant message data for
  future frontend rendering). Still needs owner confirmation before #20
  hardens the shared type around it.

## Hardening review (critique of the branch as delivered)

Findings from the review pass against `origin/main..HEAD` at branch fork
point:

1. **Delivery gap (found)**: commit `fd8052c` contained only steps 1–2
   (`.env.example`, `webSearchService`, unit tests); the tool loop, SSE
   status event, and `sources` persistence — the issue's acceptance path —
   were missing; `webSearch` was dead code. All of steps 3–7 implemented
   in-tree since.
2. **Env name mismatch (was a silent-disable bug)**: the delivered service
   read only `BRAVE_API_KEY` while the local key is exposed as
   `BRAVE_SEARCH_API_KEY` — the tool would have been silently disabled.
   Fixed: both names accepted; unit test pins the fallback.
3. **Breakability verified**: a route-level permissions test mocked the Groq
   client returning a raw streaming shape, and the initial implementation
   crashed on `first.choices[0]` when `choices` is absent. Fixed
   (`first.choices?.[0]`); the permissions test locks it in.
4. **New tests added**: tool-round execution + `sources` persistence
   (non-streaming), no-tool-call path (no `sources`, single completion),
   empty-search degradation, streaming path with `status` SSE event + exact
   `streaming-create` call assertions, service fallback env name, malformed
   JSON body handling, `global.fetch` teardown leak.
5. **Live verification done**: a real call against the Brave API with the
   local key produced results in exactly the mapped shape
   (`title`/`description` on `web.results[]`).
6. **Client SSE check**: the client (`src/client/src/App.tsx`) splits on
   `\n\n` and silently ignores unknown `event:` types — the `status` frame
   is safe. Rendering "Searching the web…" in the UI, and rendering
   `sources` on the assistant message at all, remain future frontend work
   (ties to the failure-visibility open question).

## Second hardening pass (critic-of-the-critic, 2026-09-11)

Re-ran the toolchain and re-read the whole diff. Findings, all fixed
in-tree:

1. **`npm run ci` was red on the branch**: `format:check` failed on
   `docs/plan-16-web-search-tool.md` itself. Fixed with `npm run format`.
   Lesson: the plan doc is in the repo-wide Prettier scope, so every plan
   edit must be followed by a format pass or CI dies.
2. **Blank-query API spend (fixed)**: the malformed-arguments fallback fed
   `''` into `webSearch`, which made a real Brave call with an empty `q` —
   wasted quota for a guaranteed-empty page. `webSearch` now short-circuits
   blank queries to `[]` without touching the API; unit test added.
3. **Tool calls without an `id` (fixed)**: `runSearchStage` echoed every
   `message.tool_calls` entry back to Groq and built `role: 'tool'`
   messages with `tool_call_id: call.id` — an entry lacking an `id` (or
   `function`) produced a malformed tool message, which Groq rejects with
   a 400, taking the whole chat turn down with a 500. Calls without a
   usable `id`/`function.name` are now dropped before anything echoes
   back; a new `toolLoopService.test.ts` locks this in (dropped-only
   round degrades to the plain-answer path).
4. **Unguarded `completion.choices[0]` (fixed)**: the non-streaming
   tool-results path indexed `choices[0]` directly; an empty `choices`
   array crashed the route into a 500. Now `choices?.[0]?.message?.content`.
5. **Duplicate `sources` (fixed)**: one search can return the same URL
   twice (and two `web_search` calls in one round can overlap). The
   `sources` provenance list is now deduplicated incrementally; test added.
6. **SSE `status` timing bug (fixed)**: the streaming route emitted
   `status: 'Searching the web…'` only _after_ `runSearchStage` returned,
   i.e. after the search (and its up-to-10s of latency) had already
   completed — the hint never covered the work it described. The route now
   passes an `onSearchStart` callback that fires immediately before the
   first `web_search` executes.
7. **New direct coverage for the loop**: `toolLoopService.test.ts` locks
   `runSearchStage` behaviour that previously only ran indirectly through
   route tests: no-choices model shape, missing-id tool calls, malformed
   JSON arguments (raw-string fallback), blank query degradation, unknown
   tool synthesis, and source dedupe.
8. **Final state**: `npm run ci` green end to end (105 server tests, client
   lint/format/tests, build). Remaining pre-PR work unchanged: rebase onto
   current `origin/main` (`src/shared/contracts.ts` etc.) and re-run CI.
