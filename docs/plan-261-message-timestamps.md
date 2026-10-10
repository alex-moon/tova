# Plan — #261 Timestamp every chat message

Branch: `feat/tv/261-message-timestamps`

## Motivation

Issue #261: the agent gets the current date/time only as a single
`Today's date is YYYY-MM-DD (UTC).` line at the top of the system prompt. That
flattens the model's view of time: every turn in a conversation looks like it
happened at the same instant, so the model cannot tell whether the user replied
in seconds, slept overnight, or went to work and came back a day later.

Fix: give every chat message a timestamp in the prompt, so the model sees both
*when* each turn happened and *how long* passed between turns.

## Decisions

- **D1 — persisted turns only; ZDR/incognito unchanged.** A persisted `Message`
  already carries `timestamp` (`models/Message.ts`). ZDR/incognito turns persist
  nothing and rely on the client's replayed `history` array, which carries only
  `role` + `content`; adding a client-sent timestamp would widen the ZDR payload
  and its validation for little benefit. ZDR keeps its role+content shape.

- **D2 — absolute timestamp + natural-language relative gap, relative only > 1h.**
  Each persisted message content is prefixed with a bracketed header:
  - absolute: `2026-10-10 14:32 UTC` (date + time, UTC — matching the
    `current_datetime` tool's UTC contract);
  - relative: appended only when the gap since the previous message exceeds one
    hour, rounded to the nearest whole unit, in plain language, scaling through
    every tier — `hours`, `days`, `weeks`, `months`, `years`:
    `2 hours since the last message`, `1 day since the last message`,
    `2 weeks since the last message`, `3 months since the last message`.
    Sub-hour gaps show the absolute stamp only.
  - **Unit selection**: compute the gap in each unit (fixed approximations —
    day 24h, week 7d, month 30d, year 365d — fine for a prompt hint), round
    each to the nearest whole unit, and pick the largest unit whose rounded
    value is ≥ 1. This gives "1 week" for 6.5 days and "1 year" for 400 days
    rather than "7 days" / "13 months".

- **D3 — the system-prompt date line is dropped for persisted turns, kept for
  ZDR.** Per-message timestamps now carry the day *and* the time-of-day, so the
  bare date line is redundant — and it was the thing "distorting" the model's
  view. ZDR turns are not timestamped (D1), so they keep the date line as their
  only clock. `buildSystemContent` gains a flag; `#52`'s tests are updated to
  the conditional contract.

- **D4 — a single pure renderer, applied in the message-assembly helpers.**
  `messagesFromPersistedHistory` gets the timestamps from the docs it already
  receives. The header formatting lives in a pure exported helper
  (`timestampHeader`) so the gap arithmetic ("nearest whole unit", the 1h floor)
  is unit-testable without a DB or provider.

- **D5 — user timezone from the browser, stored in UTC-land, used only to
  *render*.** (Owner decision, extending the ticket.) The stored clock and all
  persisted data stay UTC — `Message.timestamp` is an absolute UTC `Date` and is
  never rewritten. The user's IANA zone is captured on the client from
  `Intl.DateTimeFormat().resolvedOptions().timeZone` (exact, offline, no
  dependency) and persisted as a plain string on `settings.timezone` via the
  existing `PATCH /api/profile`. The server uses it **only at prompt-render
  time** to show the user-facing times in their local zone; storage and logs are
  untouched. Country→timezone mapping was rejected: our geolocation is
  country-level by design (#50) and a country code maps to many zones (US → 6+),
  so it would be a guess plus a tz-database dependency.

- **D6 — prompt times render locally, labeled, with a UTC fallback.** The
  per-message header and the date line render in the user's zone (e.g.
  `[2026-10-10 20:15 BST]`) when a zone is known, together with its name so the
  model is never ambiguous about the offset; without a zone they fall back to
  UTC exactly as built in D2/D3. `current_datetime` reports the user's local
  time and their real UTC offset (the placeholder field is finally filled), or
  UTC + `null` offset when no zone is known.

## Done

- [x] Pure `timestampHeader(now, previous, timezone?)` helper (absolute +
      > 1h relative, whole-unit rounding through hours → days → weeks →
      months → years; local-zone rendering with a UTC fallback)
- [x] `messagesFromPersistedHistory` prefixes each persisted message with its
      header (previous turn's stamp drives the relative gap); the just-saved
      current turn included; the user's zone shapes the rendered stamp only
- [x] `buildSystemContent`: date line conditional (dropped for persisted, kept
      for ZDR); rendered in the user's local zone when known; a one-time
      `The user's timezone is … (currently …).` context line rides both paths
- [x] Timezone capture (D5): `settings.timezone` on User, `timezone` on the
      `AuthUser` wire contract + `toAuthUser`, `profilePatchSchema` validation
      against the platform IANA list, profile PATCH persistence, and a
      once-per-session browser report in `AuthContext`
      (`Intl.DateTimeFormat().resolvedOptions().timeZone`)
- [x] `current_datetime` tool: description/instructions updated — it returns
      the authoritative UTC instant and the model states local time using the
      prompt's zone context (the tool itself stays per-agent/UTC; the offset
      field stays an honest null)
- [x] Server tests: header format + gap rounding + 1h floor; local-zone
      rendering (BST/GMT/`GMT+5:30`/`GMT-4`), invalid-zone fallback, context
      line; persisted prompt stamps locally and drops the date line; ZDR keeps
      the date line unstamped; profile PATCH accepts/rejects zones; existing
      #52 and #34/#115 prompt-assembly tests updated to the new contract
- [x] Client tests: AuthContext reports the browser zone once, skips a
      matching zone, survives a failed report
- [x] Gate: `npm run ci` green (exit 0), 1084 tests
- [x] Live check against the local stack: login from a Europe/London browser
      persisted `settings.timezone` via the new report; a live turn answered
      "It's 19:49 for you, on Saturday 10 October 2026" (19:49 BST while the
      stored `Message.timestamp` was `18:49Z` — storage UTC, prompt local);
      a seeded 33h overnight gap rendered as `1 day since the last message`.
      The chat UI is unchanged — the header is prompt-only.

## Follow-ups

- **Time contract for the Workspace epic (#251)**, recorded for its slices: the
  model sees the **user's local time** (with the IANA zone named) in anything
  user-facing — chat turns here, and steering/task surfaces when #254/#255
  build them; **task/machine timing stays UTC** (deadlines, step boundaries,
  worker clocks). Storage, logs, and the DB are UTC always; zones are
  render-time only.
