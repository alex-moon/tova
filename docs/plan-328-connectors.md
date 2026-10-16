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
- Slice 1 (#327, PR #337): OAuth engine on MCP SDK 1.32.1 auth primitives; in-memory
  pending consents (TTL, user-bound); encrypted token vault in the connector doc carrying
  AS metadata + full DCR client info (SDK refresh does not re-discover); proactive
  single-flight refresh; `authState: 'ok' | 'needs-reauth'` wire field; re-auth via
  `/:id/reauth`; SSRF-parity (public https) on all discovered endpoints; provider error
  detail never echoed. Client: `/connectors/callback` route + minimal section affordances.

## Done

- [x] #329 groundwork (connector model, types, shared contracts, migration) — PR #336
- [x] #327 OAuth engine for `mcp.oauth` connectors — PR #337
- [x] #330 curated OAuth connector catalog (hand-verified: Trello, Atlassian, Notion, Linear, Dropbox, GitHub-PAT) — PRs #343, #345
- [x] #331 `/connectors` UI (grid, modal, mobile-first) — PR #338
- [x] #332 PAT per-provider instructions — PR #339
- [x] #342 static/BYO OAuth clients for DCR-less providers — PR #345
- [x] #333 wash-up (re-scoped at close-out: OAuth-required copy, in-chat health, 413 copy, alias retirement, RFC 7009 revocation, golden-six view) — this PR
- [ ] Final epic PR to `main` with `npm run ci` green

## Follow-ups

- Tracked on the individual slice tickets and #333's follow-up list (connector health
  surfacing, watchlist cadence, platform-scope connectors in the catalog, `api`/`sdk` types).
