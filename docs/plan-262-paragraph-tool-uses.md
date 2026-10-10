# Plan — #262 New paragraph between tool uses

Branch: `feat/tv/262-paragraph-tool-uses`

## Motivation

Issue #262: when a turn streams text, then runs a tool, then streams more text,
the two text segments are concatenated in the rendered answer with no visual
separation — "thoughts run into each other". A tool use between two text runs
should render as a paragraph break.

## Decisions

- **D1 — insert the break server-side, into the persisted content.** The turn's
  answer text is accumulated in `assistantContent` (`apps/server/src/routes/chat.ts`)
  and saved verbatim as `Message.content`. Tool use is a server-side fact (the
  neutral stream interleaves `text-delta` / `tool-call` / `tool-result` /
  `text-delta` chunks), so the break is inserted where it is known, not
  reconstructed on the client. Storing it means the live stream, a refresh, and
  the persisted history all agree (the issue explicitly blesses storing it if
  that is the most correct route).

- **D2 — a blank line (`\n\n`) as the separator.** The client renders assistant
  content as Markdown (`MarkdownContent`), so a blank line is the natural
  paragraph break and needs no client change. This keeps the change to one
  server file plus tests.

- **D3 — one break per text→tool→text boundary, no leading/trailing break.** A
  `toolCall` and its `toolResult` are two chunks for the same tool use; only one
  break may appear. The server arms a `toolRanSinceText` flag on any tool chunk
  that follows already-streamed text, and the next non-empty delta consumes it,
  topping the tail up to exactly one blank line via the pure `paragraphBreakFor`
  helper. A tool *before* any text (the common search-first turn) therefore adds
  nothing, and a tool that ends the turn leaves no trailing break.

## Done

- [x] Server: arm a break when a tool chunk follows streamed text; the next
      delta is topped up to exactly one blank line via the pure
      `paragraphBreakFor` helper (`chat.ts`)
- [x] Server tests: text→tool→text yields blank-line-separated persisted
      content (and the break rides the delta stream); `paragraphBreakFor`
      boundary cases; tool-ending turn has no trailing break
- [x] Gate: `npm run ci` green (exit 0)
- [x] Live Playwright check against the local stack (mobile viewport): sent a
      search prompt; the assistant turn rendered two `<p>` paragraphs with the
      tool summary above, and `Message.content` persisted
      `"…now.\n\nWhat I did: …"` — the break lands exactly where the tool ran

## Follow-ups

- None planned.
