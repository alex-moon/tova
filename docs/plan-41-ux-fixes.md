# Plan: UX fixes (#41) — collapsed sources list, theme-switcher follow-ups

- **Ticket:** [alex-moon/tova#41](https://github.com/alex-moon/tova/issues/41)
- **Branch:** `feat/tv/41-ux-fixes`
- **Scope:** chat UI (`src/client`, plus tiny logic-only pieces), small well-contained fixes.

## Motivation

Issue #41 reports three UX problems from a review of the current chat UI:

1. Follow-up suggestions from the assistant are never shown to the user.
2. The Sources list can grow very long and clutters the conversation.
3. The dark/light theme switcher does nothing.

The intent is a chat UI that *demotes* secondary content (sources) and *honours*
explicit user choices (theme), with follow-up prompts actually surfacing.

## State of the repo (verified from code, not the issue text)

Important finding: two of the three items are **already implemented on `main`**
(commits `225759c` and `1f2f12a`, which the branch HEAD `20821ef` includes):

| Issue item | Repo state | Conclusion |
|---|---|---|
| 1. Follow-ups not shown | Server generates suggestions (`src/server/routes/chat.ts:379-387`), delivers them on the SSE `done` event, persists them (`Message.ts:57`, `App.tsx:197-199`), and the UI renders `FollowupChips` you can click (`ChatWindow.tsx:177, 249, 440`). Server and client tests cover the path (`chat.stream.test.ts:296`, `ChatWindow.features.test.tsx:133`). | **Done.** No work planned; verifiable via smoke test already covered by tests. |
| 2. Sources list too long | `SourcesBlock` (`ChatWindow.tsx:98-112`) always renders the full `<ul>` of URLs. No collapse, no "show all". | **Not done — remaining work.** |
| 3. Theme switcher does nothing | `ThemeToggle.tsx` persists and applies the choice; `index.css:46-119` has a complete light palette, a `.dark` override and a system-preference fallback. **However** there is a real defect: `applyTheme` only toggles the `dark` class on `<html>`. When the OS prefers dark and the user picks *light*, `index.css:96`'s `@media (prefers-color-scheme: dark) { html:not(.light, .dark) { … } }` re-applies dark, so the switcher *still* appears to do nothing in that common case. | **Mostly done; one class-toggling bug remaining.** |

So this plan covers two small deliverables, not three rewrites. The plan was
deliberately scoped to what the repo does not already have.

## Checklist

Each task is one self-contained commit.

- [ ] **Task 1 — fix theme switcher override bug (`fix`)**

      In `ThemeToggle.tsx`, make `applyTheme` set *both* classes explicitly:
      `classList.toggle('light', !dark)` and `classList.toggle('dark', dark)`.
      In the uninitialised case (`theme === null`), add no class so the
      system-preference fallback in `index.css` applies unchanged.
      - Add/extend a client test asserting `document.documentElement` carries
        `light` (not `dark`) after an explicit light choice.
      - Update `aria-label` logic if needed (it already keys off the same
        conditions, likely no change).
      - Verify: `npm --prefix src/client run lint`, `npm --prefix src/client run test`, plus a
        manual smoke test with `prefers-color-scheme: dark` (toggle → light sticks).

- [ ] **Task 2 — collapse Sources block by default (`feat`)**

      Render the first 3 sources; when the list is longer, show a
      "Show all N sources" toggle button that expands to the full list
      (see `SourcesBlock`, `ChatWindow.tsx:98-112`).
      - Collapse resets per message (stateless per render is fine — local
        `useState(false)` per block instance).
      - Keep `data-testid="sources-block"` stable; add e.g.
        `data-testid="sources-show-all"` for the button so
        `ChatWindow.features.test.tsx` can be extended with: collapsed default,
        expand shows everything, no button when ≤ 3.
      - Verify: client lint + vitest, format check, and the existing "Sources
        block" tests still pass unchanged (2 sources stay fully visible).

- [ ] **Task 3 — final gate**

      Run `npm run ci` (full server+client lint/format/typecheck/tests/build)
      and fix anything surfaced by the earlier tasks.

No backend or Mongo work is expected; the suggestions pipeline already works.

## Decisions so far

- Items 1 and 3 as originally worded are closed by pre-existing work; we only
  close the *residual* part of item 3 (the `:not(.light, .dark)` interaction)
  and the untouched item 2. Communicating this in the PR body is part of the
  work so the issue author knows why the scope shrank.
- The "show all" control is a simple in-block toggle rather than a modal or a
  `<details>` element — matches the existing plain `SourcesBlock` markup and
  keeps the change small.

## Open questions

- **Collapse threshold:** the issue says "collapsed by default with a show all
  button" but not how many entries to show. I plan to show **3** before
  collapsing; this is a guess. If the author wants a different number or a
  height-capped scroll box instead, that is a trivial tweak — flagging before
  implementing rather than bikeshedding later.
- **Item 1 verification:** the end-to-end path (SSE → chips) is covered by
  automated tests, but the issue claims it "never reaches the user". If the
  reporter observed this against the *current* build, something environmental
  may be involved (e.g. a very old session in Mongo without stored
  suggestions). I'll only open an issue if a live smoke test reproduces it; per
  the cleanup-scope policy I will not chase it inside this ticket without
  confirming.
