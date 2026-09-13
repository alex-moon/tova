# Plan: UX fixes (#41) — collapsed sources list, theme-switcher fix

- **Ticket:** [alex-moon/tova#41](https://github.com/alex-moon/tova/issues/41)
- **Branch:** `feat/tv/41-ux-fixes`
- **Scope:** chat UI (`src/client`, tiny logic-only pieces only), small well-contained fixes.

## Motivation

Issue #41 reports three UX problems from a review of the current chat UI:

1. Follow-up suggestions from the assistant are never shown to the user.
2. The Sources list can grow very long and clutters the conversation.
3. The dark/light theme switcher does nothing.

The intent is a chat UI that _demotes_ secondary content (sources) and _honours_
explicit user choices (theme), with follow-up prompts actually surfacing.

## State of the repo (verified from code, not the issue text)

Important finding: two of the three items are **already implemented on `main`**
(commits `225759c` and `1f2f12a`, which the branch HEAD `20821ef` includes):

- **Item 1 — Follow-ups not shown: Done on main.** Server generates
  suggestions (`src/server/routes/chat.ts:379-387`), delivers them on the SSE
  `done` event, persists them (`Message.ts:57`, `App.tsx:197-199`), and the UI
  renders `FollowupChips` you can click (`ChatWindow.tsx:177, 249, 440`). Server
  and client tests cover the path (`chat.stream.test.ts:296`,
  `ChatWindow.features.test.tsx:133`). No implementation work planned; see
  Task 0 for a live smoke test.
- **Item 2 — Sources list too long: was not done; delivered in this review pass.**
  `SourcesBlock` (`ChatWindow.tsx:98-112`) originally always rendered the full
  `<ul>` of URLs with no collapse and no "show all".
- **Item 3 — Theme switcher does nothing: mostly done on main; one class-toggling
  bug remained.** `ThemeToggle.tsx` persists and applies the choice;
  `index.css:46-119` has a complete light palette, a `.dark` override and a
  system-preference fallback. The defect: `applyTheme` only toggled the `dark`
  class on `<html>`. When the OS prefers dark and the user picks _light_,
  `index.css:96`'s `@media (prefers-color-scheme: dark) { html:not(.light, .dark)
{ … } }` re-applied dark, so the switcher appeared to do nothing in that common
  case.

So this plan covers two small deliverables, not three rewrites. It is deliberately
scoped to what the repo does not already have.

## Checklist

### Task 0 — live smoke test of follow-ups (verification only, no code)

Run the full stack (`npm run stack:up` if Mongo is down, then the dev server),
send a chat message that produces suggestions, and confirm:

1. The SSE `done` event carries `followUps` (DevTools network tab).
2. `FollowupChips` render under the assistant message.
3. Clicking a chip sends it as a new prompt.

Expected outcome: the path works (automated tests already cover it), and this
task exists only to disprove the issue reporter's observation. If it reproduces
live, stop and report on #41 _before_ opening any new ticket — do not chase it
in this one (cleanup-scope policy).

Say explicitly in the PR body what was observed, so item 1 is closed with
evidence rather than assumption.

**Run during the review pass — item 1 REPRODUCED live.** Details:

- Stack up, registered a test user, streamed a chat turn over SSE.
- The final `done` event carries **no `suggestions`** field; nothing is
  persisted in Mongo. Automated tests keep passing because their mocks do not
  model the live configuration.
- Root cause chain:
  1. `BRAVE_SEARCH_API_KEY` (set in this environment) makes every Groq
     completion go through the Mastra agent with the `web_search` tool baked
     in (`mastraService.ts` `agentFor` → `toolsEnabled`).
  2. The suggestion model `allam-2-7b` rejects any call that carries tools
     ("`tool calling` is not supported with this model"), so
     `generateFollowups` throws → catches → returns `[]` every time.
  3. A direct raw Groq REST call with the same prompt (tools omitted) works
     and returns clean JSON arrays, confirming the model and prompt are fine.
     With tools disabled at the connector there is a second, independent failure:
     the model occasionally emits non-JSON prose (e.g. a set literal
     `{'German', 'English', 'Spanish'}`), which the strict `JSON.parse`
     discards wholesale instead of dropping just the malformed content.

**The fix is server-side** (`followupService`/`mastraService`), outside the
ticket's declared scope, so per the cleanup-scope policy it is reported here
for author confirmation rather than fixed unilaterally in this ticket.

### Task 1 — fix theme switcher override bug (`fix`) — done

1. In `ThemeToggle.tsx`, `applyTheme` now sets both classes explicitly:
   - `theme === null` → no class at all, so the `html:not(.light, .dark)`
     system-preference fallback in `index.css:96` keeps working.
   - `theme === 'light'` → add `light`, remove `dark`.
   - `theme === 'dark'` → add `dark`, remove `light`.
2. CSS audit confirmed `:root`/`html.light` styling applies and nothing else
   toggles the class outside `ThemeToggle.tsx`.
3. `aria-label` keys off the same conditions as before — verified, unchanged.
4. Extended `ThemeToggle.test.tsx`: with `prefers-color-scheme: dark` mocked,
   explicit light keeps `light` without `dark`; fresh load gets no class;
   system-dark → toggle → light → toggle → dark round-trip asserted.
5. Verified with client lint + vitest. A DevTools-emulated manual smoke
   (toggle → light sticks; reload → still light) still needs to happen before
   merge if it has not already.

### Task 2 — collapse Sources block by default (`feat`) — done in review pass

Delivered late by the review agent; the first implementation pass on this
branch skipped it entirely.

1. `SourcesBlock` in `ChatWindow.tsx` gained a local `useState(false)` for
   `expanded` and a `COLLAPSED_SOURCES_COUNT = 3` constant.
2. When `!expanded && sources.length > 3`, only the first 3 items render plus
   a `data-testid="sources-show-all"` button labelled "Show all N sources".
3. At 3 or fewer, the full list renders with no button.
4. `data-testid="sources-block"` unchanged; per-message state means old
   messages stay collapsed; no Mongo or SSE/API contract change.
5. Expanded state offers a "Show fewer sources" toggle back to collapsed.
6. `ChatWindow.features.test.tsx` extended with the three planned cases;
   the existing two-sources test passes unchanged.

### Task 3 — final gate

No backend or Mongo work is expected; the suggestions pipeline already works.

## Decisions so far

- Items 1 and 3 as originally worded are closed by pre-existing work; we only
  close the _residual_ part of item 3 (the `:not(.light, .dark)` interaction)
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

- **Assumption:** item 1 is already done. _Backed by_ server+client automated
  tests and code reading. _Weakness:_ the issue reporter claims it "never
  reaches the user" — against some build, that may have been true. Task 0 exists
  specifically to falsify this before the PR claims it; if it reproduces live,
  this assumption collapses and item 1 goes back to open.
- **Assumption:** the theme defect is only the class-toggling bug. _Backed by_
  the CSS audit above. _Weakness:_ jsdom's `matchMedia` is stubbed in tests, so
  an integration regression involving the CSS media query itself would not show
  in vitest — hence the DevTools-emulated manual smoke in Task 1.
- **Assumption:** hiding sources beyond the first 3 does not break downstream
  consumers of the DOM/test ids. _Backed by_ the test id audit above. _Weakness:_
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
  the user". If the reporter observed this against a _current_ build, something
  environmental may be involved (e.g. a very old session in Mongo without
  stored suggestions). Task 0 resolves this by live smoke test; an open ticket
  is only filed if a live repro is found, and per the cleanup-scope policy it
  will not be chased inside this ticket without author confirmation.

- **Debug script residue:** the first implementation pass also left a
  throwaway `scripts/test-followup.ts` (commit "the") that imports the server's
  `followupService` hard-codedly, requires a configured Groq key, and is
  referenced nowhere. Removed during review; flag any objection in the PR.
- **Task 0 never evidenced:** plan said the follow-ups smoke test would be
  reported in the PR body. Nothing in this branch shows it was run. Either run
  it before merge or close item 1 explicitly on automated-test evidence only.

- **Follow-ups need a server-side fix (needs author confirmation):** item 1
  reproduced live; the fix touches `followupService`/`mastraService`
  (deliver followup generation without the web-search tool attached, plus a
  more tolerant array parser). Both files sit outside the ticket's declared
  `src/client` scope. Confirm and I will either fold it in here or split it
  into its own ticket.
