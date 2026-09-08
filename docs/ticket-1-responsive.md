# Ticket 1 — Make the app responsive for mobile

Tracking doc so work can be picked up by another agent at any point. Source of truth: [issue #1](https://github.com/alex-moon/tova/issues/1).

**Branch:** `feat/tv/1-responsive` · **PR target:** `main`

## Scope (from issue)

- Sidebar → collapsible drawer on small screens (overlay + backdrop, hamburger in header), fixed on `md+`.
- `100dvh` instead of `100vh` so mobile browser chrome/keyboard doesn't clip the composer.
- Composer footer rework: drop the fixed-height `h-28` positioning hack; flow naturally; send button one-hand reachable.
- Scale empty-state heading and message padding with breakpoints.
- Safe-area insets for notched devices.
- **Explicitly deferred by the issue wording:** `visualViewport` keyboard behaviour ("revisit", not in acceptance).
- **Acceptance:** usable at 375px end-to-end (login, new chat, stream, session switch).

## Out of scope

- Theme/branding work (that's issue #2 — do not restyle colors here).
- Google OAuth (issue #3).

## Status

- [x] Branch created from latest `main`
- [x] Read current layout: `index.css` (fixed `--sidebar-width`), `App.tsx` (`h-screen` flex row), `Sidebar.tsx` (always-visible static column), `ChatWindow.tsx` (`h-28` absolute-positioned footer), `Login.tsx` (`h-screen w-screen`)
- [x] Sidebar drawer on mobile + hamburger header bar
- [x] `100dvh` + composer flow rework + safe-area padding
- [x] Breakpoint scaling of empty state / message padding
- [x] `npm --prefix src/client run lint`, client tests + build pass
- [x] Committed & pushed; PR opened

## Implementation notes (for handover)

- Drawer state (`sidebarOpen`) lives in `App.tsx`; passed to `Sidebar` (`open`, `onClose`) and `ChatWindow` (`onOpenSidebar`).
- `Sidebar` renders as `fixed` overlay drawer (translate-x) under `md`, backdrop div, static column `md+`.
- New `ChatWindow` mobile header bar (`md:hidden`) carries the hamburger; desktop needs no header.
- `h-screen` → `h-dvh` in App main and Login. Footer is now a normal flex child with `env(safe-area-inset-bottom)` padding.
- Note: `Login.tsx` card is fixed `w-80` (320px) — fits 375px viewport, left as-is to avoid drifting into issue #2 territory.

## If interrupted

Next agent: verify `npm run ci`, then commit/push/PR if not done. Handover notes above cover what changed and why.
