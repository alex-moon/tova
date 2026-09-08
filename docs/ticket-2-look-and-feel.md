# Ticket 2 — More engaging/welcoming look and feel

Tracking doc so work can be picked up by another agent at any point. Source of truth: [issue #2](https://github.com/alex-moon/tova/issues/2).

**Branch:** `feat/tv/2-look-and-feel` · **PR target:** `main`
**Stacked on** `feat/tv/1-responsive` (PR #6, not yet merged) — the token/CSS layer this ticket reworks was touched there, so it branches off it to avoid conflicts.

## Scope (from issue)

- Warmer brand primary + hover ramp and matching accent; dark mode intentional (toggle), not just `prefers-color-scheme`.
- Add missing semantic tokens: `muted` bg, real `success` usage, `warning`, `info`; stop deriving `--color-text`/`--color-bg` aliases after the fact.
- Empty state: subtitle + example prompt chips that fill the composer.
- Message styling: softer borders, role label/avatar for assistant messages, animated thinking indicator.
- Micro-interactions: sidebar rows, message fade/slide-in, focus-visible.
- Typography: sweep UI headings back to `font-heading` (Raleway).
- **Acceptance:** light + dark both verified, no hard-coded hex in components, empty state and error states look intentional.

## Out of scope

- Theme toggle on the Login screen (toggle lives in the sidebar footer there is no sidebar pre-auth; Login follows system preference). Candidate follow-up if wanted.

## Status

- [x] Branch created off `feat/tv/1-responsive` (`87ef005`)
- [x] Token rework in `index.css`: warm terracotta primary (`#c2593c`, hover `#a84a31`) + accent ramp, `muted`, `warning`, `info`, `destructive-foreground`; `success` now used for later consumers (defined + kept); `msg-user`/`msg-assistant` derive from `accent`/`bg`
- [x] Theme via CSS variables in `:root` / `.dark` class / `html:not(.light,.dark)` media fallback; `color-scheme` set per theme
- [x] `ThemeToggle.tsx` (sun/moon, persists to `localStorage` as `tova-theme`), wired into sidebar footer next to Logout
- [x] Empty state: heading + subtitle + 3 example chips that fill the composer and refocus it
- [x] Messages: `animate-message-in` fade/slide, assistant role label with "T" avatar chip, user bubble `border-primary/25`, error bubble restyled destructive
- [x] Thinking indicator: three pulsing dots (`.thinking-dot` staggered keyframes) + avatar row
- [x] Micro-interactions: sidebar rows get `transition-colors`, active state `text-accent-foreground font-medium`, `focus-visible:outline-primary`; buttons/cards `transition-colors`
- [x] Typography sweep: empty state, mobile chat header, sidebar title already use `font-heading`; `CardTitle` now `font-heading text-xl`
- [x] Light + dark verified in browser (screenshots): empty state, session view, error state; `tova-theme` persistence checked
- [x] `npm run ci` green (server 20 tests, client 2 tests, lint/format/typecheck/build)
- [x] `npm run test:e2e` green (8/8)
- [x] Committed & pushed; PR opened: https://github.com/alex-moon/tova/pull/7

## Implementation notes (for handover)

- Theming is driven entirely by CSS variables on the `html` element, so Tailwind v4 `@theme` tokens (`--color-*`) referencing `var(--color-bg)`/`var(--color-text)` react to the `.dark` class without a Tailwind `dark:` variant. No `@custom-variant dark` was needed — only variable-based tokens are used (`@theme` aliasing happens inside it).
- Dark mode precedence: explicit `.dark`/`.light` class (toggle writes `.dark` + `localStorage`) > `prefers-color-scheme` (only when no class has ever been set). Simplified first-interaction flow: first toggle adopts current system look, then writes explicit state.
- `msg-user`/`msg-assistant` are now aliases of accent/bg rather than separate hexes per theme — no per-theme message colors to maintain.
- Composer `bg-msg-assistant` == page background now; the border + `shadow-sm` carry the container affordance (was a white panel before).
- Login card heading got `font-heading`; markdown-body headings stay Roboto deliberately (document readability, not UI chrome).
- No hard-coded hex left in components; all colors resolve through `@theme` tokens.

## Manual verification (browser, 2026-09-08, dev stack client :5173 / api :5000)

- [x] Login page renders with Raleway card title; light/dark follows system before first toggle
- [x] Light empty state: heading + subtitle + chips; chip click fills composer (`document.querySelector('textarea').value` verified)
- [x] Dark mode via toggle: `tova-theme=dark` persisted, body bg `rgb(33, 28, 26)`, sun/moon label flips
- [x] Session view both themes: assistant "T" avatar + role label, model attribution line, active sidebar row accent styling
- [x] Failed stream (mocked 500 on `/api/chat/stream`): destructive red bubble renders, no orphan empty assistant message
- [x] Note: server can persist model-side error text as a _normal_ assistant message (content arrives via delta, e.g. Groq API failure prose) — renders normal styling; pre-existing behaviour, not a client error state.

## If interrupted

Nothing outstanding — acceptance criteria met, everything green. Tests that could still catch regressions: `npm run ci` and `npm run test:e2e` (needs `npm run stack:up`, `npm run db:migrate`, `npm run dev`).
