# Plan: UX fixes (#41) — collapsed sources list, theme-switcher fix

- **Ticket:** [alex-moon/tova#41](https://github.com/alex-moon/tova/issues/41)
- **Branch:** `feat/tv/41-ux-fixes`
- **Scope:** chat UI (`src/client`, tiny logic-only pieces only), small well-contained fixes.

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
| 1. Follow-ups not shown | Server generates suggestions (`src/server/routes/chat.ts:379-387`), delivers them on the SSE `done` event, persists them (`Message.ts:57`, `App.tsx:197-199`), and the UI renders `FollowupChips` you can click (`ChatWindow.tsx:177, 249, 440`). Server and client tests cover the path (`chat.stream.test.ts:296`, `ChatWindow.features.test.tsx:133`). | **Done.** No implementation work planned; see Task 0 for a live smoke test. |
| 2. Sources list too long | `SourcesBlock` (`ChatWindow.tsx:98-112`) always renders the full `<ul>` of URLs. No collapse, no "show all". | **Not done — remaining work.** |
| 3. Theme switcher does nothing | `ThemeToggle.tsx` persists and applies the choice; `index.css:46-119` has a complete light palette, a `.dark` override and a system-preference fallback. **However** there is a real defect: `applyTheme` only toggles the `dark` class on `<html>`. When the OS prefers dark and the user picks *light*, `index.css:96`'s `@media (prefers-color-scheme: dark) { html:not(.light, .dark) { … } }` re-applies dark, so the switcher *still* appears to do nothing in that common case. | **Mostly done; one class-toggling bug remaining.** |

So this plan covers two small deliverables, not three rewrites. It is deliberately
scoped to what the repo does not already have.

## Checklist

Each task is one self-contained commit.

- [ ] **Task 0 — live smoke test of follow-ups (verification only, no code)**

      Run the full stack (`npm run stack:up` if Mongo is down, then the dev
      server), send a chat message that produces suggestions, and confirm:

      1. The SSE `done` event carries `followUps` (DevTools network tab).
      2. `FollowupChips` render under the assistant message.
      3. Clicking a chip sends it as a new prompt.

      Expected outcome: the path works (automated tests already cover it), and
      this task exists only to disprove the issue reporter's observation. If it
      reproduces live, stop and report on #41 *before* opening any new ticket —
      do not chase it in this one (cleanup-scope policy).

      Say explicitly in the PR body what was observed, so item 1 is closed with
      evidence rather than assumption.

- [ ] **Task 1 — fix theme switcher override bug (`fix`)**

      Concrete steps:

      1. In `ThemeToggle.tsx`, change `applyTheme` to set *both* classes
         explicitly:
         - `theme === null` → no class at all, so the `html:not(.light, .dark)`
           system-preference fallback in `index.css:96` keeps working.
         - `theme === 'light'` → add `light`, remove `dark`.
         - `theme === 'dark'` → add `dark`, remove `light`.
         Use two `classList.toggle(..., force)` calls guarded on `theme !== null`
         rather than a blanket `classList.add`.
      2. Audit `index.css`: confirm `:root` / `html.light` styles apply (they
         already exist at `index.css:46+`); confirm nothing else in the codebase
         toggles the `dark` class outside `ThemeToggle.tsx` and the legacy
         matches check (`rg "classList.*dark" src/client`).
      3. `aria-label` already keys off the same conditions — verify, don't change.
      4. Extend the existing `ThemeToggle` client test: with
         `prefers-color-scheme: dark` mocked (jsdom `matchMedia`), assert
         `document.documentElement` has `light` and not `dark` after an explicit
         light choice, and no class on a fresh load.
      5. Verify: `npm --prefix src/client run lint`,
         `npm --prefix src/client run test`, plus manual smoke with DevTools
         `prefers-color-scheme: dark` emulation (toggle → light sticks; reload →
         still light).

- [ ] **Task 2 — collapse Sources block by default (`feat`)**

      Concrete steps:

      1. In `SourcesBlock` (`ChatWindow.tsx:98-112`), add a local
         `useState(false)` for `expanded`.
      2. When `!expanded && message.sources.length > COLLAPSED_SOURCES_COUNT`
         (constant `3`, see Open question below), render only the first 3 `<li>`
         plus a button `data-testid="sources-show-all"` labelled "Show all N
         sources".
      3. When ≤ 3 sources, render the full list, no button.
      4. Keep `data-testid="sources-block"` unchanged; per-message state means
         old messages stay collapsed (matches the existing stateless rendering;
         nothing to persist in Mongo, and no SSE/API contract change).
      5. Extend `ChatWindow.features.test.tsx` with three cases: default
         collapsed with > 3 sources, expand shows everything and then collapses
         back, and full-list-no-button at exactly 3.
      6. Verify: client lint + vitest, `npm run format:check`, and confirm the
         existing "Sources block" tests (2 sources) still pass unchanged.

      This task does **not** depend on the open threshold question: it proceeds
      with the constant, and a different agreed number is a one-line change
      afterwards. The constant's value, not the task's existence, is what is
      uncertain.

- [ ] **Task 3 — final gate**

      Run `npm run ci` (server+client lint, format check, typecheck, tests,
      client build) and fix anything surfaced by Tasks 1–2.

No backend or Mongo work is expected; the suggestions pipeline already works.

## Decisions so far

- Items 1 and 3 as originally worded are closed by pre-existing work; we only
  close the *residual* part of item 3 (the `:not(.light, .dark)` interaction)
  and the untouched item 2. Communicating this in the PR body is part of the
  work so the issue author knows why the scope shrank.
- The "show all" control is a simple in-block toggle rather than a modal or a
  `<details>` element — matches the existing plain `SourcesBlock` markup and
  keeps the change small. A height-capped scroll box was considered and
  rejected: it needs scroll math that is flaky in tests and does not match the
  issue's "show all button" wording.
- `expanded` state intentionally does not persist: the issue asks for
  "collapsed by default", which always-restart-collapsed satisfies, and it
  avoids touching storage or the server contract.

## Assumptions (critiqued)

- **Assumption:** item 1 is already done. *Backed by* server+client automated
  tests and code reading. *Weakness:* the issue reporter claims it "never
  reaches the user" — against some build, that may have been true. Task 0 exists
  specifically to falsify this before the PR claims it; if it reproduces live,
  this assumption collapses and item 1 goes back to open.
- **Assumption:** the theme defect is only the class-toggling bug. *Backed by*
  the CSS audit above. *Weakness:* jsdom's `matchMedia` is stubbed in tests, so
  an integration regression involving the CSS media query itself would not show
  in vitest — hence the DevTools-emulated manual smoke in Task 1.
- **Assumption:** hiding sources beyond the first 3 does not break downstream
  consumers of the DOM/test ids. *Backed by* the test id audit above. *Weakness:*
  any e2e test beyond `ChatWindow.features.test.tsx` that reads sources from the
  DOM could break — Task 3's full `npm run ci` is the safety net.

## Open questions

- **Collapse threshold (asked on #41):** the issue says "collapsed by default
  with a show all button" but not how many entries to show. I plan to show **3**
  before collapsing; this is a guess. If the author wants a different number or
  a different control, that is a trivial tweak. Not blocking: Task 2 uses the
  constant either way.
- **Item 1 environmental cause (asked on #41):** the end-to-end path (SSE →
  chips) is covered by automated tests, but the issue claims it "never reaches
  the user". If the reporter observed this against a *current* build, something
  environmental may be involved (e.g. a very old session in Mongo without
  stored suggestions). Task 0 resolves this by live smoke test; an open ticket
  is only filed if a live repro is found, and per the cleanup-scope policy it
  will not be chased inside this ticket without author confirmation.
