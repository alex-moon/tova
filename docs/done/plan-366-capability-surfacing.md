# Plan: #366 Capability surfacing

## Motivation

[#366](https://github.com/alex-moon/tova/issues/366) (split out of #360): the user cannot tell,
from the product, whether "there is no such tool" means the tool is absent, present-but-not-
called, or present-but-deferred behind `search_tools` discovery. The agent self-reports from
its in-context view, so it can be wrong.

## Decisions

- **Server is the source of truth**: a lightweight, authenticated `GET /api/capabilities`
  returns (1) built-in tool rows with a status computed from deployment config — `web_search`
  is the one config-gated tool (Brave key) and reports `unconfigured` without it; everything
  else reports `ready` — and (2) the caller's live connector toolsets (`connectorToolsetsForUser`,
  TTL-cached, cheap) as `deferred` groups. Tools absent from the response are genuinely absent.
- **Three states, mapped** (acceptance): absent = not in the list; present-but-not-called = in
  the list while the turn's tool chips (#196) don't show it; present-but-deferred = listed
  under connectors ("needs discovery").
- **Client surface**: a "What can Tova do?" toggle on the footer's privacy-note row (mobile-
  first, no new chrome), expanding a panel with the two groups. Fetched lazily on first open
  like the recent-assets list. Connector tools link to `/connectors` when there are none.
- **Not in scope**: per-turn automatic joining of chips to the capability list (the human joins
  them visually); tool descriptions beyond a truncated line.

## Done

- [x] `routes/capabilities.ts` + registration in `index.ts`
- [x] Client service + panel in `ChatWindow` (toggle, lazy fetch, groups, empty state)
- [x] Route test (auth, built-ins incl. unconfigured web_search, deferred connector groups)
- [x] Client test (toggle + render)
- [x] `npm run ci` green

## Follow-ups

- None planned.
