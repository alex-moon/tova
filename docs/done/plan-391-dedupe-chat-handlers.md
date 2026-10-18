# Plan 391 — deduplicate the chat turn handlers

## Motivation

[#391](https://github.com/alex-moon/tova/issues/391), from the #382 audit. The two chat
handlers in `apps/server/src/main/routes/chat.ts` (POST `/` non-streaming, POST `/stream`
SSE) are ~70% copy-paste and have drifted. The ticket lists the duplicated surfaces plus
five same-surface bugs. Sequenced right after #387, which merged (the routing block both
handlers duplicate is gone with the roster).

## Decisions

- **Helpers stay in `routes/chat.ts`** (not a new service module): the test suites import
  the exported helpers from the route file; moving them would churn imports for no gain.
- **Shared `prepareTurn`** covers the identical preamble: content/permission/asset/user-doc
  validation, the ZDR turn decision + session lookup, the 409/400/404 error paths, and the
  ZDR history parse. It returns a `{ error }` union; handlers map that to `res.status`.
  Asset cleanup on internal throws stays exact: `prepareTurn` cleans the ephemeral asset
  before rethrowing (the handlers' outer catch keeps its own unconditional cleanup, which
  no-ops if `prepareTurn` already adopted-and-cleaned).
- **Shared prompt builders**: `buildZdrTurnPrompt` (client-replay history + system + asset)
  and `buildPersistedTurnPrompt` (session create, user save, windowed history, geolocation,
  workspace block, task drain, system + asset, trace metadata). Ordering inside the builders
  preserves both handlers' current sequences.
- **ZDR image drift unified toward streaming**: today non-streaming ZDR turns never attach
  image parts (comment claims "never") while streaming ZDR turns do attach presigned image
  parts. No test pins either. Unified to streaming behavior (images ride as presigned GET
  parts, nothing persisted); the legacy non-streaming endpoint gains parity, the client
  path is unchanged.
- **Shared `persistAssistantTurn`**: assistant save (same field set), `markNotified`,
  `maybeReviseSubtitle`. Honesty verdict field and the suggestions second-save stay in the
  streaming handler; `reviewAssistantTurn` fire-and-forget stays in non-streaming.
- **`max_tokens` drift died with #387, as the ticket predicted**: post-roster, all raced
  backends serve `CHAT_MODEL`, so the pre-computed cap matches the crowned winner. No code
  change needed beyond the meta fix below.
- **SSE `meta` moves after the race**: it previously named the pre-race pick
  (`chatRoute()` = first backend). With hedged racing the crowned backend can differ, so
  `meta.routing` could name a provider that never served the turn. The race resolves at the
  winner's first chunk, which stays buffered until consumption — so meta still precedes
  every delta.
- **SSE keep-alive**: a comment-frame ping (`: ping\n\n`) every 15s starts before each
  race attempt and is cleared when it resolves, covering the silent header-to-first-token
  window (and honesty retries). SSE comments are ignored by parsers.
- **`windowedHistory` always retains the newest turn**: when the newest message alone
  busts `HISTORY_MAX_CHARS` the old loop broke before counting it, yielding a prompt with
  no user message. The newest turn is now always kept, truncated to the budget when it
  alone exceeds it.
- **Double-limit resolved by consolidation, not removal**: the Mongo `.limit` bounds the
  fetch (perf); `windowedHistory`'s message cap is its exported, test-pinned contract.
  Both stay; with one shared query site the drift risk the ticket flagged is gone.
- **`appendAssetBlock` guarded**: only appends the envelope when the last message's
  content is a string (defensive on the `string | MessageContentPart[]` union).

## Done

- [x] `prepareTurn` extracted; both handlers map `{ error }` to responses
- [x] `buildZdrTurnPrompt` / `buildPersistedTurnPrompt` extracted
- [x] `persistAssistantTurn` + `sourceTitlesFrom` extracted
- [x] `windowedHistory` newest-turn retention (truncated) + tests
- [x] `appendAssetBlock` string guard
- [x] SSE `meta` after the race
- [x] SSE ping keep-alive until first chunk
- [x] `npm run ci` green

## Follow-ups

- None tracked. The deferred guard-model redaction work lives under #383/#388, unrelated.
