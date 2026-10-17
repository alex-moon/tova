# Plan — #359: chat title (user-owned) + subtitle (system-maintained)

## Motivation

[#359](https://github.com/alex-moon/tova/issues/359). Chat names are derived
from the opening message once and never change; the library sidebar shows the
failure mode (`Can you view this link`, truncated first messages). The ticket
splits the header into a **title** the user owns and a **subtitle** the system
keeps current — the subtitle is also the scope signal #355/#357 (adjacency)
will consume later.

## Decisions

- **Metadata-only ticket.** Retrieval/adjacency wiring is #355/#357's job; this
  ticket only persists and displays the signal.
- **Schema:** `Session.subtitle: string | null` and
  `Session.titleSource: 'system' | 'user'` (default `'system'`). The system
  never overwrites a title after a user rename — the field encodes that, and
  future title-regeneration schemes can check it in one place.
- **Rename endpoint:** `PATCH /api/chat/sessions/:id` with `{ title }` —
  trims, requires 1–120 chars, sets `titleSource: 'user'`. Ownership guard
  mirrors the DELETE route (`userId` + `deletedAt: null`).
- **Subtitle generation clones `titleService.ts`:** tool-free aux call on
  `config.aux.model` (`openai/gpt-oss-20b` on Groq — the ticket's model
  choice), 512 max_tokens for reasoning headroom, fallback = current subtitle
  (or null) on error/empty. Hard cap 80 chars client-side of the prompt's
  "at most ten words".
- **Cadence: fire-and-forget after the assistant save** (both the non-stream
  and stream routes; ZDR returns before both, so nothing is generated for
  ephemeral chats). First subtitle after turn 2 (one full exchange), revision
  every 6th assistant turn after that (`turns === 2 || turns % 6 === 0`).
  Input = current subtitle + last 3 turns, each truncated to 400 chars —
  tight context, revision framing ("here's what you said this was — is it
  still?"). Never awaited in the turn path: the subtitle is a soft, revisable
  signal and must not add turn latency.
- **Client cadence:** the existing post-turn `fetchSessions()` (App.tsx
  `finally`) picks up subtitle changes; a freshly revised subtitle may land one
  turn later — acceptable eventual consistency for a soft signal.
- **Header (mobile-first):** the ChatWindow header currently shows brand only.
  Once a session is active it becomes hamburger | title + muted subtitle
  (min-w-0, truncate) | logo. Tap the title to rename (inline input,
  Enter/blur saves, Esc cancels); empty input keeps the old title. No active
  session → brand as today.
- **Sidebar:** subtitle rides under the title as a muted secondary line when
  present.
- **Back catalogue:** leave historical titles as-is (cheapest answer to the
  ticket's open question — the first-message title is just the default a user
  may rename).
- **Subtitle editing is out of scope** (the ask says subtitle is
  system-maintained); user subtitle edits would be the highest-quality intent
  annotation, so it is the first candidate follow-up.

## Done

- [x] Server: `Session.subtitle` + `titleSource`
- [x] Server: `subtitleService.ts` + unit tests
- [x] Server: `PATCH /sessions/:id` + route tests
- [x] Server: post-turn fire-and-forget revision (both routes)
- [x] Client: header (title, subtitle, rename), sidebar subtitle line, App wiring
- [x] Client tests updated
- [x] `npm run ci` green
- [x] Playwright check at 375–390px (no overflow, hierarchy readable)

## Verified live (local stack, 2026-10-17)

- Two fresh turns produced the subtitle *"Watering balcony herbs during
  summer."* — five words, no preamble, accurate scope; the aux default
  (`openai/gpt-oss-20b` on Groq) held the prompt discipline without
  escalation.
- Rename through the header persisted (`titleSource: 'user'` in the DB) and
  the sidebar reflects it.
- Sidebar shows the subtitle as a muted second line; header shows title over
  subtitle; no horizontal overflow at 360px; full responsive e2e suite green
  (60/60, mobile + desktop).

## Follow-ups

- Subtitle edit affordance for users (intent annotation; feeds #355/#357).
- Watch wrong-subtitle cases à la #289; tune cadence/prompt from evidence.
