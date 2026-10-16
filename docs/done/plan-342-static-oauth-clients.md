# Plan — #342: Static/BYO OAuth clients (providers without dynamic registration)

Epic: #328 · Branch: `feat/tv/342-static-oauth-clients` · PR target: `epic/328-connectors`

## Problem

The #327 OAuth engine is DCR-based (RFC 7591). The #330 verification pass proved four
curated providers cannot ride that path — their authorization servers have no
`registration_endpoint` (GitHub serves none at all; Slack demands `client_secret_post`;
Google never has; Spotify requires pre-registered apps). Each surfaces as the honest 422
from #330.

## Ask

Operator-configured static OAuth clients: `CONNECTORS_OAUTH_CLIENTS` env — JSON map from
authorization-server origin to `{ clientId, clientSecret }`. When the probed AS has an
entry, `startConnectorOAuth` skips DCR and uses the static client; the vault persists the
client information exactly as the DCR case does, so token exchange and refresh work
unchanged (the SDK handles `client_secret_post` from `clientInformation`).

## Connector menu (evidence in #342, probed 2026-10-16)

| Connector | Unblocked by this work? | Owner-side setup |
|---|---|---|
| Slack | ✅ | Slack app + User Token Scopes, redirect `<origin>/connectors/callback` |
| Spotify | ✅ | Spotify dashboard app; pilot endpoint caveat stands |
| Google Drive / Gmail / Calendar | ✅ | Google Cloud OAuth client; preview enrollment surfaces at consent if still required |
| Dropbox | ✅ (probed 2026-10-16: AS `www.dropbox.com` has no `registration_endpoint`) | Dropbox developer app + scopes, redirect, app key/secret |
| GitHub (OAuth-first) | ✅ | GitHub OAuth app; restores #332's preferred GitHub story |
| Google Maps | ❌ stays watchlisted | PR doc 404s — no public endpoint |

## Work

- [ ] Static-client env parsing + lookup by AS origin (warn-and-ignore on bad JSON)
- [ ] `startConnectorOAuth`: static client preferred over vaulted DCR, both over fresh DCR
- [ ] Tests: static used when configured (no DCR call), DCR path untouched otherwise
- [ ] `.env.example` entry
- [ ] `npm run ci` green
- [ ] Live verification per connector (owner creates apps, consents; states flip as they pass)
