# Plan — #327: OAuth support for personal MCP servers

## Motivation

Ticket: [#327](https://github.com/alex-moon/tova/issues/327) (Epic
[#328](https://github.com/alex-moon/tova/issues/328)). Every first-party consumer MCP server
we actually want (Notion, Slack, Trello, Linear, Dropbox, Spotify) is OAuth 2.0/2.1 only —
there is no token to paste. Without OAuth the curated catalog is capped at a handful of
token-authable servers.

## Decisions

- **Library-first**: use the MCP SDK's auth primitives (`@modelcontextprotocol/sdk/client/auth.js`,
  v1.32.1 — `discoverOAuthProtectedResourceMetadata`, `discoverAuthorizationServerMetadata`,
  `registerClient`, `startAuthorization`, `exchangeAuthorization`, `refreshAuthorization`).
  No hand-rolled RFC plumbing; tests mock the SDK at the module boundary.
- **Tova is the OAuth client; the browser is the consent surface.** Flow:
  1. `POST /api/connectors/oauth/start` `{name, url}` — server probes discovery on the
     endpoint (`/.well-known/oauth-protected-resource`, RFC 9728, path-inserted variant
     included via the SDK, then the authorization-server metadata, RFC 8414). No OAuth →
     422 with a message telling the user the token form still works. Duplicate URL → 409.
     Otherwise: dynamic client registration (RFC 7591) at `registration_endpoint`, PKCE
     `startAuthorization`, and a pending record `{state → codeVerifier, clientInfo, AS
     metadata, url, name, redirectUri, userId?, connectorId?}` → returns
     `{authorizationUrl}`; the client redirects the browser there.
  2. Provider consents → browser lands on the client route `/connectors/callback`
     (same-origin app in dev via the Vite proxy and in prod via the static build —
     index.ts:90 — so no CORS story is needed).
  3. The callback page POSTs `{code, state}` to `POST /api/connectors/oauth/callback`; the
     server matches the pending record, `exchangeAuthorization`, encrypts tokens, creates
     (or updates, for re-auth) the connector doc, handshakes to cache tools → `{connector}`.
- **Redirect URI = the requesting origin** + `/connectors/callback`: derived from the
  `Origin` (POST) / `Referer` header of the start request, with the
  `CONNECTORS_OAUTH_ORIGIN` env override for non-standard deployments. Since DCR happens
  per-flow, we register exactly the redirect_uri we will be redirected from; no absolute
  origin needs to be configured for dev/prod.
- **Pending auth records are in-memory** (Map + 10-minute TTL): nothing secret is stored
  (PKCE verifier and state only, no tokens), the app is single-process, and abandoned
  consents self-clean. A server restart mid-consent fails the exchange with "expired" —
  the user just retries. No new collection, so the purge sweep is untouched. The record
  is deleted only after the exchange settles (the provider code is single-use), so the
  client's StrictMode double-fire in dev cannot race itself into a false failure; the
  client service also dedupes in-flight completions by state.
- **Token vault inside the connector doc** (the #327 purge interlock): new model field
  `oauth` holds the same AES-256-GCM envelope shape as `headers`, containing
  `{accessToken, refreshToken?, expiresAt?, tokenType?, scope?, authorizationServerUrl,
  metadata?, clientInformation?}` — the full AS metadata (refresh does NOT re-discover;
  without it the SDK would POST to `{asUrl}/token` and miss custom endpoints) and the
  full DCR client info (so refresh keeps the registered auth method) ride in the vault.
  Plus `authState: 'ok' | 'needs-reauth'` (default `'ok'`): set to `'needs-reauth'` when a
  refresh fails (revoked/expired grant), surfaced on the wire, clearable only by a
  successful re-auth; a known-dead grant short-circuits (no doomed refresh per turn).
- **Refresh proactively, at the auth seam**: `authFor`'s `mcp.oauth` branch decrypts the
  vault and returns a bearer header, refreshing first when the access token is expired or
  expiring within a 60 s skew. Refreshes are single-flight per connector (in-flight promise
  map) so concurrent chat turns cannot race a rotating refresh token. A failed refresh
  marks `authState: 'needs-reauth'` and returns no auth — the connector then handshakes
  anonymously, gets dropped from toolsets on 401 (existing degrade path), and the UI shows
  re-connect. Reactive refresh on 401 is NOT built: the SDK transport's built-in 401 path
  wants a browser redirect mid-request, which is unusable server-side; the proactive
  window (60 s) plus the needs-reauth surface covers the real cases.
- **Re-auth without delete**: `POST /api/connectors/:id/reauth` starts the same flow for an
  owned `mcp.oauth` connector; the pending record carries `connectorId`, and the callback
  updates that row instead of creating a new one. `GET`-visible grant death + one-click
  re-connect satisfies the acceptance. A vault registration is reused only against the AS
  that issued it — a moved `authorization_servers` entry gets a fresh DCR.
- **SSRF posture parity**: every discovered OAuth endpoint (the RFC 9728
  `authorization_servers` entry and the AS metadata's authorization/token/registration
  endpoints) must be a public https URL or the connect fails with 422 — same bar as the
  connector url itself. Provider error detail is never echoed to the client (raw response
  bodies can ride SDK errors); fixed messages per failure class, detail in server logs.
  The client also refuses to navigate to a non-https consent URL (defense in depth).
- **Graceful degradation**: nothing about `mcp.pat` changes. `POST /api/connectors` still
  only creates pat connectors — `type: 'mcp.oauth'` there now gets a specific message
  ("connects via OAuth sign-in, not a pasted token") pointing at the flow, distinct from
  the reserved-type and unknown-type messages.
- **Slice-1 UI is minimal by design** (the real UI is #331): a "Connect with sign-in"
  button beside the add form (start + `window.location.href` to the consent URL) and a
  standalone `/connectors/callback` route that completes the flow and links back. Existing
  token form untouched.

## Done

- [x] Shared contracts: `authState`, `ConnectorOAuthStartInput`/`Start`/`CallbackInput`
- [x] Model: `oauth` vault envelope + `authState` field (tests: defaults, toJSON strip)
- [x] OAuth engine service: discovery probe, DCR, PKCE start/exchange, refresh, vault
      (unit tests with mocked `fetchFn`)
- [x] Routes: `/oauth/start`, `/oauth/callback`, `/:id/reauth` (+ validation schemas,
      route tests covering 422/409/400/201 and the reauth path)
- [x] `authFor` mcp.oauth branch with proactive refresh + needs-reauth marking
- [x] Client: `startOAuth`/`completeOAuth`/`reauth`, `/connectors/callback` route,
      "Connect with sign-in" affordance in the section
- [x] `npm run ci` green

## Follow-ups

- Hand-verification gate for the curated catalog is #330 (real accounts).
- RFC 7009 revocation on factory reset — optional nicety, noted on #327; not built (token
  copy dies with the doc; the provider grant lives until expiry).
- Reactive-on-401 refresh: revisit only if the proactive window proves insufficient.
