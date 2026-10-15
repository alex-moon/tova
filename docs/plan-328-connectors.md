# Plan — Epic #328: Connectors for normal people

## Motivation

Epic ticket: [#328](https://github.com/alex-moon/tova/issues/328). Replace "personal MCP
servers" with **connectors** — a curated, consumer-facing concept. Normal people don't know
what an MCP endpoint is; they know they want "my Notion" and "my Dropbox" connected. The epic
re-models the plumbing (connector types), ships OAuth so the big providers are connectable
(#327), rebuilds the UI as a proper connectors view (#331), and curates the catalog by market
share (#326).

## Slices and dependency order

0. **#329 Groundwork — connector model & contracts** (first; everything builds on it)
1. **#327 OAuth support** — discovery, browser consent, token lifecycle
2. **#330 OAuth connector catalog** — needs 0 + 1
3. **#331 Connectors UI** — needs 0
4. **#332 PAT connectors** — needs 0
5. **#333 Quick wins & follow-ups** — independent, can start immediately

Order: 0 → {1, 3, 4}; 2 after 1; 5 anytime.

## Decisions

- (recorded as slices land — see each slice's plan doc for detail)
- Slice 0 (#329, PR #336): `ConnectorType = 'mcp.pat' | 'mcp.oauth' | 'api' | 'sdk'` lives
  in `@tova/shared` (`apps/shared/src/connectors.ts`); only `mcp.pat` storable until #327.
  Collection migrated `mcpservers` → `connectors` (renameCollection + `type` backfill).
  Wire field `authConfigured` replaces `headersConfigured` as the type-agnostic seam.
  `mcpService` → `connectorService` with a per-type `authFor` dispatch; MCP wire internals
  unchanged; model-visible `mcp_` toolset key prefix kept (trace/eval churn avoidance).

## Done

- [x] #329 groundwork (connector model, types, shared contracts, migration) — PR #336
- [ ] #327 OAuth engine for `mcp.oauth` connectors
- [ ] #330 curated OAuth connector catalog (hand-verified)
- [ ] #331 `/connectors` UI (grid, modal, mobile-first)
- [ ] #332 PAT per-provider instructions
- [ ] #333 quick wins (suggestion refresh, add-time error copy)
- [ ] Final epic PR to `main` with `npm run ci` green

## Follow-ups

- Tracked on the individual slice tickets and #333's follow-up list (connector health
  surfacing, watchlist cadence, platform-scope connectors in the catalog, `api`/`sdk` types).
