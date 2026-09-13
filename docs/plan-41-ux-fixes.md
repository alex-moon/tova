# Plan: UX fixes (#41) — collapsed sources list, theme-switcher fix, follow-ups

- **Ticket:** [alex-moon/tova#41](https://github.com/alex-moon/tova/issues/41)
- **Branch:** `feat/tv/41-ux-fixes`
- **Revised scope:** one server-side fix (`followupService`/`mastraService`, author
  confirmed), one client placeholder fix, plus the already-delivered client items
  below. The original `src/client`-only scope was widened by the author's
  approval of the follow-up server fix on #41.

## Motivation

Issue #41 reports three UX problems from a review of the chat UI. Comment thread
added two more inputs: the reporter tests on mobile, and the follow-up problem
"in reality" turned out to be the chat input's placeholder text.

## State of the repo (verified from code, not the issue text)

- **Item 1 — Follow-ups: reproduced live on this branch.** Server generates
  suggestions (`src/server/routes/chat.ts:379-387`), delivers them on the SSE
  `done` event, persists them, and `FollowupChips` render and click
  (`ChatWindow.tsx:203-250, 465`). Client side is fine and covered by tests.
  The live path fails _server-side_: `generateFollowups`
  (`followupService.ts:21`) routes through `inferenceService.createCompletion`
  → `mastraService` connectors, and `agentFor` (`mastraService.ts:221-237`)
  attaches the `web_search` tool to every Groq agent whenever
  `BRAVE_SEARCH_API_KEY` is set. `allam-2-7b` rejects tool-carrying requests,
  so generation throws → catch → `[]` every time. With tools disabled, the
  model additionally emits non-JSON prose (e.g. a set literal
  `{'German', 'English', 'Spanish'}`), which the bracket-extraction +
  `JSON.parse` in `followupService.ts:31-35` discards wholesale. A raw REST
  call with the same prompt (no tools) returns clean JSON arrays, so the model
  and prompt are fine. **Fix: Task 4.**
- **Item 2 — Sources list: delivered on this branch** (review pass).
  `SourcesBlock` in `ChatWindow.tsx` collapses to the first 3 items behind a
  `COLLAPSED_SOURCES_COUNT = 3` constant, with "Show all N sources" /
  "Show fewer sources" toggles and three new client test cases. Threshold 3
  confirmed by the author on #41.
- **Item 3 — Theme switcher: delivered on this branch.** `ThemeToggle.tsx`
  `applyTheme` now sets/removes both `light` and `dark` classes; empty class
  when the user has not picked a theme, preserving the
  `html:not(.light, .dark)` system-preference fallback in `index.css`. Test
  cases cover dark→light under emulated system-dark, fresh load, and the full
  toggle round-trip.
- **Placeholder (from comments, not the original ticket text): not started.**
  `ChatWindow.tsx:250` picks a random static placeholder once per mount;
  `ChatWindow.tsx:474` puts it on the textarea. The reporter's real complaint:
  on mobile the placeholder is noise once a conversation is underway. Fix:
  Task 5.
- **Branch debris: cleaned.** The throwaway `scripts/test-followup.ts` from the
  first pass is removed.

Remaining work is therefore Task 4 and the final gate (Task 6).

## Checklist

### Task 1 — fix theme switcher override bug — done

`applyTheme` in `ThemeToggle.tsx` now sets both classes explicitly (`theme ===
null` → no class, keeping the `index.css:96` system fallback; `'light'` →
`light` without `dark`; `'dark'` → `dark` without `light`). Extended
`ThemeToggle.test.tsx` accordingly. Client lint + vitest green.

**Residual before PR/merge:** a DevTools-emulated manual smoke matching a real
browser (toggle → light sticks; reload → still light), since jsdom stubs
`matchMedia` and cannot validate the CSS media query itself. Do this in Task 6.

### Task 2 — collapse Sources block by default — done

`SourcesBlock` in `ChatWindow.tsx`: collapse to first 3 (`COLLAPSED_SOURCES_COUNT
= 3`), "Show all N sources" / "Show fewer" toggle button
(`data-testid="sources-show-all"`), `data-testid="sources-block"` unchanged, no
server contract change, per-message state (old messages stay collapsed). Three
new cases in `ChatWindow.features.test.tsx`. Threshold 3 confirmed on #41;
one-line constant change if the author ever wants another number.

### Task 0 — live smoke test of follow-ups — done (repros)

Ran the stack, streamed a turn: the `done` event carries no `suggestions`;
nothing persisted in Mongo; automated tests stay green because their mocks do
not model the tool-attached live configuration. Root-cause chain documented
above under Item 1. Repro reported on #41; author approved the server-side fix
in this ticket: _"Server side fix is the way to do this yes - without the
search tool!"_ Task 4 implements it.

### Task 4 — generate follow-ups without the search tool + tolerant parsing (server)

The author's mental model — _"Should be simple text generation for follow ups
no?"_ — is correct; the fix keeps it simple:

1. **Tool-free generation path.** Suggestions do not need search. The problem
   is that `inferenceService.createCompletion` always routes through
   `agentFor`, which bakes `web_search` into every Groq agent when the Brave
   key is set. Give `mastraService` a tool-free connector for one-off
   completions (suggestions never carry tools regardless of the key):
   `inferenceService` gains an explicit tool-free createCompletion, or the
   connector factory takes a tools flag. Keep the wiring inside
   `mastraService.ts` (it is the single owner of `@mastra/*` imports); the
   `web_search` streaming path used by the main chat must not change.
2. **Followup service uses it.** `followupService.ts:21` switches to that
   path. Model, prompt, trimming and `MAX_SUGGESTIONS` stay as-is.
3. **Tolerant parser.** Replace the strict bracket-slice in
   `followupService.ts:31-35` with parsing that drops just the malformed
   content instead of the whole response:
   - try the `[a, b]` slice first (current behaviour);
   - on failure, fall back to extracting the first `[…]` array with a
     regex + `JSON.parse`;
   - on failure, fall back to splitting the raw text on newline/semicolon
     boundaries and keeping the same post-filters (`typeof string`, 1–60
     chars, strip quotes, max 3) so a set literal or prose with usable lines
     still yields suggestions;
   - never throw — empty array on total failure, as today.
4. **Tests.** Extend the server suite: (a) generation succeeds with the search
   key set and the suggestion model rejects tools — assert the completion
   request carries no `tools` (unit on the new path or the connector); (b)
   parser handles a set literal and prose-with-lines; (c) the
   empty-on-failure contract is preserved.
5. **Verify live.** Re-run the Task 0 smoke: `done` event carries suggestions,
   chips render, Mongo persists. Note the result on #41 (the earlier comment
   promised a report after the fix).

Constraint noted: `BRAVE_SEARCH_API_KEY` exists in this environment; the fix's
live verification depends on that environment staying as configured.

### Task 5 — hide the composer placeholder once the user has spoken (client) — done (desktop)

From the author's comment: _"Probably simplest fix is remove it after the user
has input at least one message."_

1. In `ChatWindow.tsx`, hide the placeholder when the conversation contains at
   least one user message (i.e. `messages.some((m) => m.role === 'user')`).
   Because this derives from `messages`, it also behaves correctly across
   reloads (history loaded from Mongo → no placeholder) and after switching or
   creating a session (empty message list → placeholder returns). Default
   behaviour assumed; asked on #41 (see Open questions).
2. Keep the random placeholder logic and `#33` empty-path comments intact —
   this only gates the `placeholder` prop on the textarea (`ChatWindow.tsx:474`).
3. Tests in `ChatWindow.features.test.tsx`: placeholder visible on fresh load
   (no messages); hidden after one user message; visible again after a
   session switch to a fresh session.
4. Manual mobile check (author tests on mobile): placeholder gone after first
   send. Fold into the Task 6 smoke.
5. Implemented: the textarea's `placeholder` prop is now gated on
   `messages.some((m) => m.role === 'user')` (`ChatWindow.tsx:474`), so it is
   hidden once a user message exists in the session — including history
   reloaded from Mongo — and returns on a fresh/empty session. Random
   placeholder logic and `#33` empty-path comments unchanged. Three cases added
   to `ChatWindow.features.test.tsx` (fresh load shows it, hidden after one
   user message, rerender transition). Client lint, root typecheck, client
   vitest (35 passed) and Prettier all green. Mobile spot check remains for
   Task 6.

### Task 6 — final gate

1. `npm run ci` (root lint, format check, typecheck, server tests, client
   lint + format + tests, client build). Known pre-existing `main` failure:
   `src/server/iteration-harness.test.ts` imports `../../scripts/iteration`,
   which commit `6f71fda` deleted while keeping the test file. Do not fix it
   in this ticket unless blocked; flag it in the PR body (offer of a separate
   ticket already on #41).
2. Manual smokes accumulated in Tasks 1 and 5 (theme toggle, mobile
   placeholder).
3. Update the PR body: what was already done on `main` vs this branch, the
   live follow-up repro, the server fix, and the placeholder rationale.
4. Move this plan doc to `docs/done/` after merge (orchestrator handles
   commits/pushes; no commits from this agent).

## Decisions so far

- The server-side follow-up fix is folded **into this ticket**, not split off:
  the author answered his own verification question on #41 with explicit
  approval, and it is the only remaining cause for the issue's item 1.
- The "show all" control is a simple in-block toggle rather than a modal or a
  `<details>` element — matches the existing plain `SourcesBlock` markup and
  the issue's "show all button" wording. Height-capped scroll box was
  rejected.
- `expanded` sources state does not persist: "collapsed by default" means
  always-restart-collapsed, and persistence would touch storage or the server
  contract for no stated need.
- Placeholder behaviour derives from `messages` so an empty/new session
  naturally regains it — no extra state, no persistence touch.

## Assumptions (critiqued)

- **Assumption (Task 4):** the live failure is fully explained by the tool
  attachment plus fragile parsing. _Backed by:_ live repro + a raw REST call
  with the same prompt succeeding, both documented in the review comment on
  #41. _Weakness:_ only one model (`allam-2-7b`, the `ROUTER_GUARD_MODEL`
  default) was exercised against the live env in one session; a different
  `ROUTER_GUARD_MODEL` could behave differently, and the tolerant parser's
  fallbacks are rule-of-thumb, not model-audited. Mitigation: tests assert the
  request carries no tools (the known, reproducible cause) and the parser
  never throws.
- **Assumption (Task 4):** suggestions should _never_ get search, even when
  the key is set. _Backed by:_ the author's explicit approval and the model's
  tool rejection. _Weakness:_ none observed; but this permanently narrows
  what suggestions can draw on (no current-events suggestions). If someone
  later wants that, it is a new feature, not this ticket.
- **Assumption (Task 5):** "at least one message" means any user message in
  the _current session's_ history, including on reload. _Backed by:_ the
  author's phrasing. _Weakness:_ he is out of the office and could mean
  something narrower (e.g. only while the input has text); asked on #41 with
  the default stated. If he corrects us, the change is one boolean gate.
- **Assumption (Tasks 1/2):** the rendered results hold up in a real browser,
  not just jsdom. _Backed by:_ code reading and CSS audit. _Weakness:_
  `matchMedia` is stubbed in vitest, so the media-query interaction is only
  provable manually — hence the Task 6 smoke.
- **Assumption:** hiding collapsed sources does not break other consumers of
  the DOM/test ids. _Weakness:_ any e2e beyond `ChatWindow.features.test.tsx`
  that reads all sources from the DOM could break; `npm run ci` in Task 6 is
  the safety net.

## Open questions

- **Placeholder lifecycle (posted on #41, not blocking Task 5):** does "remove
  after the user has input at least one message" mean hidden for the rest of
  the session (including reloads, and returning only on a fresh/new session)?
  The plan assumes exactly that; if the author prefers a narrower reading
  (e.g. a one-time dismissal, or only while the input has content), the change
  is a single boolean gate. Task 5 does not depend on the answer to proceed.
- **Live verification environment for Task 4:** the repro and its fix
  verification both depend on `BRAVE_SEARCH_API_KEY` staying set in this
  environment, and the reporter's original observation happened on a build he
  cannot name ("out of the office"). If the key disappears or the live stack
  is unavailable when Task 4 lands, the fix would ship on automated-test
  evidence only; that would be noted in the PR body, and wait for the author
  for a mobile spot check either way. Not blocking implementation.

Previously asked and answered on #41 (now folded into the plan; they are no
longer open): the sources collapse threshold (3 — confirmed), the environmental
theory for the missing follow-ups (disproved — it reproduced live and its
server-side fix was approved).
