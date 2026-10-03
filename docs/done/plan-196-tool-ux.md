# Plan — #196 Tool UX

Branch: `feat/196-tool-ux`

## Motivation

Issue #196 bundles four tool-use UX defects in the chat surface:

1. The in-progress chip (throbber) never disappears — a `call` event and its
   later `result` event render as two separate chips, so the original spinner
   is never replaced.
2. The success chip's expand arrow only reveals `1 results`, which is already
   on the chip — the detail toggle is pointless.
3. Tool chips disappear on page refresh (they were not persisted).
4. Long tool-heavy turns need a compact "Used N tools" summary box that can be
   expanded.

The server half (persist reconciled tool summaries on the assistant `Message`,
replay them on history load) landed earlier on this branch. This pass finishes
the client half and settles the two presentation questions the ticket reserves
for a proposal (expand-arrow content; summary-box placement).

## Decisions

- **D1 — server reconcile (already landed).** `reconcileToolEvent`
  (`src/server/routes/chat.ts`) merges a `result` into the most recent open
  `call` of the same name, carrying its query forward; unmatched results are
  standalone. The reconciled array is persisted as `Message.tools` and returned
  by `GET /chat/sessions/:id`, so a refresh rehydrates chips. ZDR turns persist
  nothing (D6), matching the existing contract.

- **D2 — fix the stuck throbber on the client (live stream).** The client
  currently *appends* raw `tool` SSE frames, so a call and its result are two
  chips. Mirror the server reconcile in `App.tsx`: a `result` frame replaces the
  matching open `call` chip instead of appending. The live chip then flips
  spinner → check in place, exactly as intended.

- **D3 — persist chips to the final message.** On the `done` frame the client
  overwrites the optimistic message; it must also copy `saved.tools` (the
  server-reconciled array), so the post-stream state matches a post-refresh
  state. Without this the optimistic (unreconciled) chips linger until reload.

- **D4 — expand-arrow content.** The arrow previously only echoed the count.
  Detail now shows the *query* (from the carried-forward call), the result
  status (`ok`/`empty`), the count when meaningful, and the domains — i.e. how
  the tool was used, not a restatement of the chip label. A resolved chip with
  nothing extra to show renders no arrow at all.

- **D5 — summary-box placement (proposed alternative to the ticket).** The
  ticket leans toward a summary box *at the end of the response, pinned to the
  bottom* as text streams. Objection: the answer text is the primary content and
  grows downward; a box pinned below it jumps as every delta arrives and pushes
  the answer. Proposal: a single collapsed **"Used N tools"** summary at the
  *top of the assistant turn* (where chips already render, before the answer),
  expanding in place to the individual chips. This keeps one stable element that
  does not move while streaming, matches natural reading order (activity →
  answer), and still collapses long tool lists behind one line. This is the
  alternative the ticket explicitly welcomes (`Any defensible objection is
  acceptable — propose an alternative`).

- **D6 — summary box while streaming.** During the turn the same summary box
  renders against the pending (in-flight) chips, so the count climbs live rather
  than a bare row of chips. It auto-expands while streaming and collapses once
  the turn settles, unless the user toggled it.

## Done

- [x] Server reconcile + persistence + history replay (earlier this branch)
- [x] `App.tsx`: reconcile live `tool` frames (call→result replaces in place)
- [x] `App.tsx`: copy `saved.tools` onto the message at `done`
- [x] `ChatWindow.tsx`: `ToolSummary` box ("Used N tools" + expand → chips),
      rendered top-of-turn; auto-expand while streaming
- [x] `ChatWindow.tsx`: richer expand detail (query, status, count, domains);
      hide arrow when there is nothing to reveal
- [x] Client tests: reconciliation, persisted chips, summary box + expand
- [x] Gate: `npm run ci` green (exit 0)
- [x] Live Playwright check against the local stack: sent a web-search prompt;
      one reconciled chip (spinner→check in place, no stuck throbber), summary
      box "Used 1 tool", expanded detail `Query: … · 20 result(s) · <domains>`,
      and `Message.tools` persisted as a single `result` entry. Reload
      rehydrates the chip (collapsed summary, expand reveals it).

## Follow-ups

- None planned. Preview/OCR/pricing work is tracked separately.
