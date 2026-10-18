# Plan — #388 + #389 chat composer transparency & tool feedback

## Motivation

Two UI tickets shipped together on one branch, both touching `ChatWindow.tsx`:

- [#388](https://github.com/alex-moon/tova/issues/388): the "what can Tova do" band sits awkwardly in the footer, squished on mobile. Replace the footer bottom band with a `?` button in the chat composer that opens a modal with the privacy statement (what "never used to train models" means and does not mean), incognito/factory-reset explanations, and the capabilities panel. Also ensure chat input text never overlaps the composer icons.
- [#389](https://github.com/alex-moon/tova/issues/389): while a tool call runs, the UI looks frozen — add a spinner next to the tool-use dropdown, cleared on result/error. Also keep the tool-use chip at the bottom of the stream while text pours in.

## Decisions

- Both tickets on one branch (`feat/tv/388-privacy-chat`), one PR: same file, same composer surface, no value in two round-trips.
- **Composer controls move from an absolute overlay into a band below the textarea** (`#388`'s overlap requirement taken structurally). The `pr-24` overlay hack is removed entirely, so text can never overlap icons at any width. Left side: `?` (privacy) + incognito (new chats); right side: attach, send-to-worker, send. If incognito is on for a fresh chat, a one-line `privacy-note` stays inline above the band — the e2e ZDR assertion depends on it being visible without opening the modal.
- **Modal, not an inline panel**: bottom sheet on phones (`items-end`), centered dialog on desktop, max-h-85dvh with internal scroll, safe-area bottom padding, Escape/overlay/X close. The `?` springboard is the only visible affordance.
- **Existing testids preserved** (`capabilities-toggle` on the `?` button, `capabilities-panel` inside the modal): the `ChatWindow.capabilities` unit tests and the responsive e2e suite pass unchanged, and the capabilities fetch stays lazy on first open (panel mounts with the modal).
- **Spinner scope**: `Loader2` beside the "Used N tools" toggle, shown only while `streaming && any tools in call phase`; it clears on result or error because results reconcile into the call event's slot by phase.
- **Chip pinning**: while tools are unresolved, the `ToolSummary` renders *below* the message text (so streaming deltas can't scroll it off); once settled it renders above, where it has always sat.
- **Models list deferred**: #387 (CHAT_MODEL/TASK_MODEL env vars) is not implemented yet, so there is no data source; #388 lists it as optional ("could also"). No follow-up issue created — it can ride #387's implementation.
- **No spinner-dedicated e2e spec**: Playwright `route.fulfill` buffers the whole SSE body before the browser sees it, so a mocked-progress spec cannot catch the mid-run state; the real-backend streaming turn was used instead (see Verify). A long-lived SSE stub server would enable one if wanted later.

## Done

- [x] Footer bottom band removed; `?` button opens `PrivacyModal` (privacy meaning/limits, incognito, factory reset, capabilities)
- [x] Composer controls in a band below the textarea; no input/icon overlap possible
- [x] Tool spinner beside the tool-use toggle while calls are unresolved; cleared on result/error
- [x] Tool summary below streaming text while tools run; above when settled
- [x] `npm run ci` green (exit 0; 306 client + 1568 server tests)
- [x] `npm run test:e2e` green: 60/60 across mobile (375px) + desktop projects
- [x] Playwright visual verification: mobile composer, modal (top and bottom sheets content), desktop layout, and a real streaming tool turn (call → result lifecycle observed on the live SSE stream)

## Verify

- `npm run ci` (full gate, mirrored by CI)
- `npm run test:e2e` (responsive suite, both projects)
- `playwright-cli` at a phone viewport for the composer and modal; real-backend turn for the tool lifecycle
