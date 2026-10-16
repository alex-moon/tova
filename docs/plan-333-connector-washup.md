# Plan — #333: Connector wash-up (epic final slice)

Epic: #328 · Branch: `feat/tv/333-connector-washup` · PR target: `epic/328-connectors`

Re-scoped at epic close-out: this is the epic's last slice AND its wash-up ticket. Full
scope lives in the ticket body; short form:

1. **Add-time OAuth-required copy** — a token-form add of an OAuth-only endpoint now
   probes discovery and says "use Connect", not the raw handshake error.
2. **In-chat health** — auth-flavored tool degrade now carries the re-connect pointer
   (`toolDegrade.degradedToolError`), the one channel the user is reading mid-chat.
3. **Chat 413 copy** — "MCP servers… settings" → connectors / `/connectors`.
4. **Alias retirement** — `/api/mcp-servers` mount + pinning test removed (404).
5. **RFC 7009 revocation on factory reset** — best-effort: vault's stored AS metadata
   names the revocation endpoint; refresh token POSTed before the row dies; failures
   never block the sweep.
6. **Watchlist cadence** — the ticket IS the home; the #330 gate's policy (DCR/PAT is
   the promotion bar; operator-app providers one at a time) is codified there.
7. **View: golden six only** (owner ask) — the grid renders `state: 'live'` entries only;
   watchlisted entries stay in the catalog as data (flip → reappears) and their providers
   remain reachable via "Add anything else by URL"; existing rows on watchlisted providers
   surface under "Added by you".

## Done

- [x] Items 1–5 + 7 implemented with tests (route/service/purge coverage)
- [x] #330/#342 plan docs archived to `docs/done/` (rode this PR — missed their own)
- [ ] `npm run ci` + `npm run test:e2e` green
