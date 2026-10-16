# Plan — #330: OAuth connector catalog (hand-verification gate)

Epic: #328 · Branch: `feat/tv/330-oauth-catalog` · PR target: `epic/328-connectors`

## Where this slice stands

The catalog data, grid UI, and OAuth flow already landed via #331/#332. What remained was the
slice's core ask: the **hand-verification gate** — "a connector ships live only after
connecting a real account end-to-end through Tova (#327 flow) and running a representative
tool call."

## Verification pass (2026-10-16, local stack)

Owner-available accounts: Trello, GitHub (PAT from the pre-epic era), Slack, Atlassian (Jira
site "AJ Moon" created mid-pass). Venue: local stack (OAuth DCR derives the redirect from
request headers, so localhost works).

## What the gate caught (this is why it exists)

1. **Missing RFC 8707 resource indicator + scopes on the authorization request.** Trello
   consent came back as Atlassian's generic Rovo **site picker** ("Your account isn't
   associated with a supported site") even for a Trello-only account: with no `resource`
   and no Trello scopes, the multi-product Atlassian AS cannot route consent to the Trello
   product. Fix in `oauthConnectors`: the probe now keeps the RFC 9728 doc, and start
   sends `resource` (verbatim from the doc) + `scopes_supported` — the token exchange,
   vault, and refresh carry `resource` too.
2. **Atlassian's catalog endpoint was wrong.** `https://mcp.atlassian.com/v1` 404s for MCP
   traffic (it is the OAuth base only); the Streamable HTTP endpoint is `/v1/mcp`
   (Atlassian community-confirmed; `/v1` was #326 research-table data). Catalog corrected;
   the gate's own rule — "endpoint URLs from directories are not evidence" — applies.
3. **GitHub and Slack do not support RFC 7591 dynamic client registration.** GitHub serves
   no AS metadata at all; Slack's AS demands `client_secret_post` and has no registration
   endpoint. Both now surface as an honest 422 ("does not support automatic app
   registration") instead of a raw 500 — previously the start route swallowed the error.
   Unblocking both needs static/BYO client support: **#342** (broadened to cover Slack).
4. **OAuth rows never test-connected.** The callback stored tokens and left
   `status: 'never-tested'` forever — cards read "Not connected" with a healthy grant.
   The callback route now runs the same live handshake the PAT path does at creation:
   tools listed, `connected` on success, honest `unreachable` on failure (the grant is
   kept — it is the expensive part).

## Final catalog state

| Connector | State | Evidence |
|---|---|---|
| Trello | `live` `mcp.oauth` | Verified: consent → callback → handshake; boards read in chat |
| Atlassian | `live` `mcp.oauth` | Verified: consent (AJ Moon site) → handshake listed Jira/Confluence tools |
| GitHub | `live` `mcp.pat` | Token-mode row (46 tools) carried from pre-epic, works in chat; OAuth → #342 |
| Notion / Dropbox / Linear | `watchlisted` | No account this pass; notes name the missing evidence |
| Slack | `watchlisted` | No DCR — needs #342; not token-pasteable |
| Google suite, Spotify | `watchlisted` | Preview gating / pilot endpoint (unchanged, per ticket) |

## Work

- [x] Verification pass: Trello, Atlassian, GitHub (PAT), Slack (blocked → #342)
- [x] RFC 8707 resource + scopes through start/exchange/vault/refresh (+ tests)
- [x] DCR failure → honest 422; start/reauth 500s now log specifics
- [x] Post-consent handshake on the callback (+ route tests both outcomes)
- [x] Catalog: Atlassian endpoint + auth type corrected; state flips with honest notes
- [x] "Back to settings" → "Back to connectors" on the OAuth callback page
- [x] `npm run ci` green (1484 tests) · e2e 60/60 mobile+desktop · no overflow at 393px
- [ ] Representative Atlassian tool call in chat (owner)

## Follow-ups

- #342 static/BYO OAuth client (GitHub, Slack, later Google) — its own ticket.
- Atlassian PAT instructions content (`connectorInstructions.atlassian`) is now orphaned
  (Rovo MCP needs the 3LO grant; an API token is not valid) — content kept for any future
  community/token-mode Atlassian-type entry via the #333 watchlist.
- GitHub OAuth instructions intro updated for the PAT-only interim (#342 restores the
  OAuth-first story); the #332 "PAT fallback disclosure for OAuth entries" test had no
  remaining catalog subject and was dropped with the flip — it returns with #342.
