# Plan — #116 ZDR option

## Motivation

[Issue #116](https://github.com/alex-moon/tova/issues/116): give users the option to use Tova
with their chats not stored at all. Files attached in chat must not be persisted to Mongo;
files uploaded in Assets must be (so they can be reused). Some copy must state that chats and
files are never used to train models — by anyone.

## Decisions

1. **Setting shape**: `user.settings.zdr: boolean` (schema default `false`, wire field omitted
   until enabled). Adding it is forward-looking only: enabling ZDR never purges data saved
   before it was turned on.
2. **ZDR chats are stateless per turn**: server writes nothing — no `Session` row, no
   `Message` rows, no fire-and-forget classification, no title generation, no follow-up
   persistence. Conversation continuity comes from a client replay: a validated `history`
   array (`zdrHistorySchema` — roles user/assistant only, ≤ 20 entries, ≤ 4000 chars each)
   riding each chat POST. Assembled into the prompt oldest-first, mirroring what
   `Message.find({ sessionId })` would return for a real session.
3. **Persisted chats cannot be continued under ZDR**: sending a `sessionId` while ZDR is on
   is a 409 with an actionable message — writing into a saved session would break the
   retention promise. Continuing an old conversation from its replayed history (no
   `sessionId`) is allowed: the new turns still save nothing.
4. **ZDR chat attachments are ephemeral**: the chat composer tags its uploads
   `scope: 'chat'`; the presign route marks the Asset `ephemeral: true` only when the
   account's own `zdr` setting is on (the tag alone never changes storage behavior — a ZDR
   account's Assets-page uploads and a non-ZDR user's chat uploads stay durable). The turn
   that consumes an ephemeral asset deletes the Mongo row and the Spaces object
   (`deleteObject`; cleanup never turns a finished answer into an error). Ephemeral assets:
   are excluded from the library listing, and confirm skips background markdown conversion
   (a job would keep extracted markdown alive in storage after the row/bytes go).
5. **Suggestions without storage**: a ZDR follow-up generation still runs and rides the
   `done` event; nothing is written.

## Done

- [x] `zdr` setting end to end: schema, validation, PATCH /api/profile, `AuthUser` contract.
- [x] Chat routes (both `/` and `/stream`): ZDR branch — no Session/Message writes,
      409 on `sessionId`, 400 on malformed history, replays, ephemeral attachment cleanup.
- [x] Asset pipeline: `ephemeral` flag, `scope` presign tag, listing filter, confirm
      conversion skip, chat-turn deletion.
- [x] Client: composer uploads tagged `scope: 'chat'`; App replays history instead of
      sending `sessionId` under ZDR; ZDR users don't auto-open saved chats on startup.
- [x] Profile modal: Privacy fieldset with the training copy ("Your chats and files are
      never used to train models — by anyone, ever.") and the Zero data retention toggle
      with persistence-scope copy.
- [x] ChatWindow footer carries the same never-trained-on copy plus a live ZDR notice.
- [x] Tests: `src/server/routes/chat.zdr.test.ts` (turn behavior, no writes, replay, 409,
      400, side-effect skips, ephemeral asset lifecycle, tagging matrix).

## Follow-ups

- Optional quota/honest-boundary note: discarded ephemeral assets still consume client-side
  upload bytes briefly in Spaces; acceptable for the turn lifetime, not double-tracked.
