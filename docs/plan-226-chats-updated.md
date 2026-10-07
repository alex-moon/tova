# Plan 226 — Chats sorted by most recent message

## Motivation

GitHub issue: alex-moon/tova#226 — "Chats updated".

> Chats should be sorted by most recent message, not by session created. This should be
> reflected in the ordering in the sidebar and should also be what's used to open the most
> recent chat on open.

Today the sidebar order is effectively **creation order**, so sending a new message into an
old chat does not move that chat to the top. The same wrong ordering feeds the
"open the most recent chat on load" behaviour, because the client simply opens
`sessions[0]`.

## What the code actually does today (verified against the tree, not assumed)

All line numbers were re-checked on this branch; the plan earlier cited a few of them
loosely, so treat these as the authoritative references.

- `Session` and `Message` are **separate collections**. `Session`
  (`src/server/models/Session.ts`) has `userId`, `title`, `deletedAt`, `incognito`, and
  Mongoose `timestamps: true` (so `createdAt` / `updatedAt`). It has **no** `messages` array
  and **no** `lastMessageAt`.
- `Message` (`src/server/models/Message.ts:112`) has its own hand-rolled `timestamp`
  (`default: Date.now`) and a `sessionId` FK. The schema does **not** use `timestamps: true`.
- The listing endpoint `GET /api/chat/sessions` sorts by activity intent:
  `src/server/routes/chat.ts:1308`
  `Session.find({ userId, deletedAt: null }).sort({ updatedAt: -1 })`.
- **But nothing ever bumps `Session.updatedAt` when a message is added.** Sessions are
  created (`createSessionWithUser`) and otherwise only mutated by the soft-delete
  (`chat.ts:1291`, whose docs are filtered out of the list anyway). Messages are saved
  exclusively to the `Message` collection (`chat.ts:509`, `chat.ts:822`,
  `chat.ts:1236`/`1257`) — the `Session` document is never touched on a normal turn.
- Net effect: `Session.updatedAt === Session.createdAt` for every message-only session, so
  `sort({ updatedAt: -1 })` behaves exactly like creation-order sorting. This is the bug.
- Client "most recent chat" logic (`src/client/src/App.tsx:138-150`) opens `sessions[0]`,
  which is correct *provided the server list is ordered correctly*. The sidebar
  (`src/client/src/components/Sidebar.tsx`) renders the array in server order, so the
  client needs **no ordering logic change** — only a refetch after a turn so a reordered
  list actually reaches the UI.
- `fetchSessions()` (`App.tsx:110-117`) is a `useCallback(..., [])`. It is called on login
  (`App.tsx:131-136`) and, on the `meta` event, only when a **new** session is created
  mid-stream (`App.tsx:253-259`). It is **not** called after a turn in an existing session,
  so even a correct server sort would not reorder the sidebar until reload.
- The client is **stream-only**: `App.tsx:181` posts to `/api/chat/stream`. There is no
  client caller of the non-streaming `POST /api/chat`, so only one client refetch call site
  matters.
- There are **no indexes** on `sessions` or `messages`. Migrations live in `migrations/`
  and follow the `mongo-migrate-ts` `MigrationInterface` pattern (see
  `migrations/20260926000100-create-model-route-errors.ts`), discovered by glob
  (`migrations/index.ts`, `globPattern: '**/*.ts'`). Deploys run `npm run db:migrate`
  (`scripts/deploy.sh:63`) after the stack is up, then restart the backend.
- `saveUserMessageWithMetrics` (`chat.ts:493-517`) is the single funnel for every persisted
  user message. Incognito/ZDR turns return earlier via the replay branch (`chat.ts:707-717`)
  and never call it, so a bump placed there cannot touch incognito sessions.

## Decisions

1. **Maintain a dedicated `lastMessageAt` field on `Session` rather than reusing
   `updatedAt`.**
   Rationale: `updatedAt` is owned by Mongoose and is also bumped by non-activity writes
   (soft-delete today, future metadata edits). Overloading it makes "last message" only
   accidentally true and fragile. A dedicated field states intent and is what the issue
   literally asks for ("most recent message"). The field defaults to `null` for sessions
   that predate the change, so the sort must handle that.

2. **Bump `lastMessageAt` once per persisted user turn**, in
   `saveUserMessageWithMetrics` (`chat.ts:493-517`), after `userMessage.save()`. The user
   turn is always the first write of a turn, so bumping here means ordering is correct even
   if the assistant reply fails, and avoids a double-write per turn. Assistant-only bumps
   are a considered alternative — see Open question 1.

3. **Sort stays server-side, keyed on `lastMessageAt`.** Change `chat.ts:1308` to
   `.sort({ lastMessageAt: -1, createdAt: -1 })`.

   **Grounded fact (verified via MongoDB docs, not assumed):** MongoDB treats a
   missing/null field as the lowest BSON type. In a **descending** sort that means docs
   without the field land **last**. So `lastMessageAt: -1` alone pushes never-messaged
   sessions to the bottom. The `createdAt` tiebreaker only orders docs *among themselves*
   when they share the same `lastMessageAt` (all null); it does **not** lift empty sessions
   above messaged ones. Accepted default: a session with no messages yet sorts beneath
   messaged sessions, by creation time. An aggregation with
   `$ifNull: ['$lastMessageAt', '$createdAt']` would instead treat a new session as active
   at creation — see Open question 3. Document the tiebreaker in a code comment.

4. **Add a compound index** `{ userId: 1, deletedAt: 1, lastMessageAt: -1 }` via a new
   migration mirroring `migrations/20260926000100-create-model-route-errors.ts`. Also
   adding a `{ sessionId: 1, timestamp: 1 }` index on `messages` is tempting but out of
   scope (scope guard) — raise as a follow-up suggestion, do not implement here.

5. **Refetch sessions after a turn completes on the client.** Add `fetchSessions()` in the
   streaming path's `finally` block (`App.tsx:335-338`). `fetchSessions` is a stable
   `useCallback([])` and only calls `setSessions`, so it does not clobber
   `activeSessionId`; the `startupSessionRef` guard (`App.tsx:108`, `138-150`) is already
   one-shot and will not re-select. This is the smallest change that makes the reordering
   visible without a reload.

6. **Do not add active-session reordering UI / animations.** Pure data-ordering fix.

## Done (checklist — each item is a single safe commit)

- [ ] **Doc**: this plan file exists at `docs/plan-226-chats-updated.md` (git-tracked,
      per AGENTS.md). `.iteration/` is git-ignored orchestrator scratch — not the
      deliverable.
- [ ] **Model**: in `src/server/models/Session.ts`, add
      `lastMessageAt: { type: Date, default: null }` between `incognito` and the schema
      options, with a short comment tying it to #226 and stating it is bumped on each
      persisted user turn. No index declaration in the schema — the migration owns the
      index.
- [ ] **Bump**: in `saveUserMessageWithMetrics` (`chat.ts:493`), immediately after
      `await userMessage.save()`, add:
      `await Session.updateOne({ _id: sessionId }, { $set: { lastMessageAt: userMessage.timestamp } });`
      Use the message's own `timestamp` (not `new Date()`) so the stored value matches the
      message it represents. Awaited: it is a single cheap update and the ordering
      guarantee should not be fire-and-forget. Confirm `Session` is already imported in
      `chat.ts` (it is — used at `chat.ts:618` and `912`).
- [ ] **Sort**: change `GET /api/chat/sessions` (`chat.ts:1308`) to
      `.sort({ lastMessageAt: -1, createdAt: -1 })` with a one-line comment explaining
      that null `lastMessageAt` sorts last and `createdAt` breaks ties.
- [ ] **Migration (index + backfill)**: new
      `migrations/<timestamp>-session-last-message-at.ts` implementing
      `MigrationInterface`:
      - `up(db)`:
        1. create the index `{ userId: 1, deletedAt: 1, lastMessageAt: -1 }` on `sessions`
           (create the collection first if it does not exist, matching the error-logs
           migration's existence-check pattern).
        2. backfill: compute, per session, `MAX(messages.timestamp)` and set
           `lastMessageAt`. Preferred implementation is a single aggregation over
           `messages` grouped by `sessionId` with `{ $max: '$timestamp' }`, then a bulk
           `updateMany`/`bulkWrite` of the results. Fallback for sessions with no messages:
           leave `lastMessageAt` null (Decision 3 handles them via the tiebreaker) — do
           **not** set it to `createdAt`, which would make an empty session look messaged
           (see Open question 3).
      - `down(db)`: drop the index; optionally `$unset: { lastMessageAt: '' }` on all
        sessions.
      - No manual registration needed — migrations are glob-discovered
        (`migrations/index.ts`).
- [ ] **Server test**: add a route test asserting ordering. Put it in the existing
      `src/server/routes/chat.test.ts` setup (the repo uses `createApp()` + `supertest` +
      a connected test Mongo; `chat.test.ts:1-36` shows the register/login helper). Test
      shape: create two sessions, message the *older* one last, then
      `GET /api/chat/sessions` and assert the older session is first. Also add a case
      asserting a never-messaged session sorts below a messaged one.
- [ ] **Client test**: the startup/refetch block in `src/client/src/App.test.tsx:137-193`
      is stale independent of #226: `mockStartup` mocks `/api/chat/sessions/recent` and
      `/api/chat/sessions/older` (`App.test.tsx:154`) and the assertions
      (`:165`, `:171`, `:179-180`, `:186`) expect those URLs, but the app fetches
      `/api/chat/sessions/:id` (`App.tsx:122`). Update the mock and assertions to match the
      real single-session URL shape, and add a case for the refetch-after-turn reordering
      the sidebar. See Open question 4 on scope.
- [ ] **Verify**: `npm run ci` passes (lint, format, typecheck, server tests, client
      lint/format/tests/build). For the client change, render at ~375px with the
      `playwright-cli` skill per AGENTS.md.
- [ ] **Ship**: PR against `main` with summary + link to this plan.

## Open questions

1. **Bump placement: user turn vs assistant turn.** The plan bumps in
   `saveUserMessageWithMetrics` (once per turn, earliest). An alternative is to bump only
   after the assistant message persists, so a chat is "recent" only once it has a reply.
   Both satisfy the issue; the user-turn choice is more robust to failed replies. Flagging
   in case the owner prefers "last completed exchange".
2. **`lastMessageAt` vs reusing `updatedAt`.** Decision 1 argues for a dedicated field.
   If the owner prefers the minimal change (bump `updatedAt` explicitly and keep the
   existing sort key), the migration/backfill become trivial but we inherit `updatedAt`'s
   other writers. Deliberately not building this alternative until confirmed.
3. **Empty/new session ordering.** With `sort({ lastMessageAt: -1, createdAt: -1 })`, a
   brand-new session with no persisted messages (created, then the user closes before
   sending) sorts below all messaged sessions. Is that desired, or should a session count
   as "active" at creation? The `createdAt` tiebreaker only helps among missing-field
   docs. An aggregation with `$ifNull: ['$lastMessageAt', '$createdAt']` would treat a new
   session as active at creation — decide before implementing the sort; the simple
   compound sort is planned by default. This also drives the backfill choice for
   no-message sessions in the migration task.
4. **Client test drift scope.** `App.test.tsx`'s per-session URL assertions are stale
   independent of #226 (AGENTS.md "known client drift"). Per the cleanup-scope policy this
   is arguably adjacent, not this ticket's scope. Intent: *fix them only as needed to keep
   the suite green while touching startup/refetch logic*, and raise the broader
   stale-assertion cleanup as a suggestion, not expand here. Flagging in case the owner
   wants it folded in.
5. **Backfill performance / implementation shape.** A grouped aggregation over `messages`
   (`$group` by `sessionId`, `$max: timestamp`) plus a bulk update is planned. If the
   collection is small, a per-session `find().sort().limit(1)` loop is simpler. Choose by
   data volume at implementation time; either is correct, but the plan should not claim
   one without seeing the data.
6. **Migration idempotency / re-run safety.** `mongo-migrate-ts` records applied
   migrations, so the backfill runs once. But the deploy script runs `db:migrate` on every
   deploy; if a migration partially failed and was not recorded, re-running the index
   creation could error on an existing index. Plan to make index creation tolerant
   (check existence first, as the error-logs migration does). Confirm this pattern is the
   repo norm before implementing.
7. **Does the bump need to be transactional with the message save?** A process crash
   between `userMessage.save()` and the `Session.updateOne` would leave a message with a
   stale `lastMessageAt`. Accepted as benign (the next turn self-heals), but if the owner
   wants strict consistency this becomes a two-collection transaction, which Mongo
   standalone does not support. Flagging rather than assuming.

## Resolved / no longer open

- **Non-streaming client path.** `App.tsx` uses `/api/chat/stream` exclusively
  (`App.tsx:181`); no client code posts to the non-streaming `POST /`. Only one
  `fetchSessions()` call site is needed. (Previously an open question; answered by
  inspection.)
- **Incognito/ZDR interaction.** Persisted incognito sessions do not exist (the route
  returns before `Session` is written; `chat.ts:707-717`), so bumping inside
  `saveUserMessageWithMetrics` cannot affect incognito chats. No special handling needed.
