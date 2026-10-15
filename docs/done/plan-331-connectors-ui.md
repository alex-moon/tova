# Plan — #331: Connectors UI — dedicated view, grid, and connect modal

## Motivation

Ticket: [#331](https://github.com/alex-moon/tova/issues/331) (Epic
[#328](https://github.com/alex-moon/tova/issues/328)). Connectors currently live as a
developer-ish settings section (`McpServersSection`) — a URL/token form with icon
suggestions. The catalog deserves its own consumer-facing view.

## Decisions

- **Catalog data is the single source in `@tova/shared`** (`apps/shared/src/connectorCatalog.ts`,
  new): `CONNECTOR_CATALOG` — ordered per the #326 market-share ranking (Google suite,
  Spotify, Dropbox, Notion, Slack, Trello, Atlassian, GitHub), each a `ConnectorDefinition`.
  The contract gains `state: 'live' | 'watchlisted'`, `watchlistNote?`, `brandColor?`.
  The client imports the catalog directly (same repo source); the server joins when
  validation needs it (#330).
- **States are honest**: watchlisted = Google suite (Developer Preview gating, #330's
  table) and Spotify (pilot endpoint) — visible "coming soon" cards, no connect. The
  Tier-A OAuth set (Dropbox, Notion, Slack, Trello, Linear) + Atlassian (token mode) +
  GitHub ship as live definitions; #330's hand-verification gate (real accounts) is free
  to flip any of them to watchlisted if the flow fails — nothing in the UI hardcodes
  optimism beyond the definition data.
- **Slack has no logo source**: simple-icons removed it (trademark request) and lucide
  dropped brand icons. `ConnectorLogo` renders simple-icons marks where available
  (`simple-icons` dependency, tree-shaken per icon) and a brand-colored letter tile
  otherwise (`brandColor` on the definition carries the fallback color).
- **Connected/not is a url-join**: catalog definitions have fixed endpoints; a personal
  connector row with the same url means connected. No model change, no catalog id on the
  doc — custom rows (url matching no definition) render in an "Added by you" list.
- **The modal** (hand-rolled overlay — no dialog primitive exists; radix-ui stays for the
  existing ui primitives): logo, name, one-line summary, "what connecting grants" copy.
  OAuth live → single **Connect** button (start + redirect, https-guarded; re-connect for
  `needs-reauth`). PAT live → masked token field + instructions block (content per
  provider lands with #332; generic honest copy until then). Watchlisted → note only.
  Connected (any type) → Disconnect. Escape/backdrop closes; focus moves in.
- **Custom connectors survive**: an "Add anything else" collapsible in the view — name +
  url + optional token (the old form), plus a "Connect with sign-in" attempt that falls
  back with the 422 guidance when discovery finds no OAuth. Power users keep a path.
- **Old surface retires**: `McpServersSection`, its test, and `mcpSuggestions.ts` (the
  #80 suggestion list) are deleted; profile hosts a link row to `/connectors`; the
  sidebar gets a Connectors entry. This supersedes #333's "refresh the suggestion list"
  quick win — noted on that ticket.
- **Mobile-first is the hard rule**: single-column grid at phone width, modal full-width
  bottom sheet style at 375–390px, verified with the `playwright-cli` skill and the
  responsive e2e suite (`/connectors` added to its route list; no horizontal overflow).

## Done

- [x] `CONNECTOR_CATALOG` in shared (+ contract fields), ordered by market share
- [x] `/connectors` route: grid with logos, live status, watchlisted "coming soon"
- [x] Per-connector modal (Connect / token + instructions / re-connect / disconnect)
- [x] Custom-connector affordance; profile link row; sidebar entry
- [x] `McpServersSection` + suggestions retired
- [x] e2e: `/connectors` in the responsive suite; connectors spec; client tests
- [x] Playwright visual pass at 375–390px; `npm run ci` green

## Follow-ups

- Per-provider PAT instruction content = #332 (`instructionsRef` content).
- Hand-verification gate + verification-driven state flips = #330.
- Connector health surfacing (unreachable/re-auth in chat) = #333 watchlist.
