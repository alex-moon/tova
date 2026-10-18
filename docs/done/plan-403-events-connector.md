# Plan 403 — Things To Do events connector

## Motivation

[Issue #403](https://github.com/alex-moon/tova/issues/403) drops one URL: https://thingstodoapi.com/ — a local-events search API "for AI agents and apps" (Show HN 2026-10-17): plain-words event search (`search_events`, `get_event`, `list_coverage`) over REST and a streamable-HTTP MCP endpoint. The gate in the ticket ("don't do until all the rest are done") is satisfied: every other open ticket is merged or shipped to a review-ready PR (#411, #412).

## Decisions

- **Connector-catalog entry, not a bespoke tool.** Tova's extension surface for third-party capabilities is the curated catalog (`CONNECTOR_CATALOG`, #328–#333) plus the MCP client that already speaks streamable HTTP with Bearer-token paste (#80/#332). The API advertises an MCP endpoint as its agent surface, so a first-class REST client would be glue code the connector system obsoletes. One catalog entry + token instructions is the whole change.
- **Verified live by hand (the #330 gate):** keyless MCP handshake, `tools/list`, and one `search_events` call all succeeded against `https://api.thingstodoapi.com/mcp` (2026-10-18); a dummy `Authorization: Bearer` key returns 401, so the endpoint reads and validates the header — Tova's `mcp.pat` paste flow (wrapped as `Authorization: Bearer`, routes/connectors.ts) will authenticate with a real key. Their docs' key-in-path form (`/mcp/YOUR_KEY`) is a convenience for header-less clients; not needed here.
- **`state: 'live'`, `authType: 'mcp.pat'`, no `iconRef`** (no simple-icons mark; letter tile in their pin red `#EF302E`). Appended after GitHub, the only other PAT entry.
- **Honest copy:** coverage is SF Bay Area only today (NYC/LA next per their FAQ) — the summary and scope note say so; the server's own instructions say to state non-coverage plainly. Free tier: 1,000 calls/month; key required to connect (the client modal requires a token).

## Done

- [x] `thingstodo` entry in `CONNECTOR_CATALOG` (endpoint `https://api.thingstodoapi.com/mcp`)
- [x] `thingstodo` token-setup instructions in `CONNECTOR_INSTRUCTIONS`
- [x] Grid-order test extended (golden six → seven) + instructions render pinned
- [x] `npm run ci` green; connectors e2e (mobile+desktop) and phone-viewport browser check pass

## Review hardening (pre-ready sweep)

- **Double-Bearer paste trap:** the provider's docs show `Authorization: Bearer YOUR_KEY`, so a
  whole-header paste produced `Bearer Bearer …` → 401 → an unhelpful "not reachable" 422. The PAT
  ingest now strips a leading `bearer ` scheme (case-insensitive) before wrapping; pinned by a
  route test.
- **Key-in-URL paste trap:** their `/mcp/YOUR_KEY` convenience form invites pasting a URL into the
  token field; the "Paste it here" step now says key only.
- **Catalog contract test:** `instructionsFor` falls back to generic copy on an unresolvable ref,
  and `watchlistNote` was comment-enforced only — a shared contract test pins unique ids, https
  endpoints, resolvable `instructionsRef`s, non-empty watchlist notes, hex brand colors, and
  instructions on every live PAT entry.
- Verified non-issues: letter-tile fallback (exercised by Slack), e2e count pins (none), grid
  ordering (catalog order), trailing-slash normalization, modal's token-required gate.

## Break/harden round (pre-ready)

- **Whole-header paste still trapped:** the first strip only removed a bare `bearer ` scheme, so the
  docs' literal `Authorization: Bearer YOUR_KEY` paste still wrapped to
  `Bearer Authorization: Bearer …` → 401 → the same unhelpful 422. The ingest now also strips an
  `authorization:` prefix (case-insensitive) before the scheme strip; pinned by route tests.
- **Scheme-only paste probe:** `Bearer`/`Bearer   ` trimmed to a bare scheme the scheme regex
  (requiring trailing whitespace) never removed, so the probe ran with `Bearer Bearer`. The strip
  now uses an end-or-whitespace lookahead and a scheme-only paste is rejected 400 ("paste the key
  only") instead of probing a knowingly-bad header; pinned by route test. Tokenless custom-add
  connects stay allowed — the 400 fires only when a paste strips to nothing.
- **Boundary safety:** `bearerly-key`-style tokens are untouched (lookahead, not a bare match).

## Follow-ups

- None yet.
