# Plan: #377 Message/Session hot-path indexes

## Motivation

[#377](https://github.com/alex-moon/tova/issues/377): `Message` and `Session` had no indexes
deserving their query load — every chat turn scanned the collection for history
(`find({ sessionId }).sort({ timestamp: -1 })`), ran `countDocuments({ sessionId })` twice per
turn (metrics), and every app load scanned sessions for the sidebar sort.

## Decisions

- `Message` → `{ sessionId: 1, timestamp: -1 }`: covers the per-turn history window (both
  directions), both per-turn `countDocuments`, and the GET-messages route.
- `Session` → `{ userId: 1, deletedAt: 1, lastMessageAt: -1 }`: covers the sidebar listing;
  the `createdAt` tiebreak stays a within-ties scan (fine at sidebar cardinality).
- Presence pinned by a test against the real collection after the suite's `syncIndexes`.
- One existing test assumed natural (insertion) order on `findOne({ sessionId, role: 'user' })`
  — unspecified order is not stable once the index exists, so the test sorts explicitly like
  the production route; the remaining unsorted `findOne` call sites are single-turn and
  order-independent.

## Done

- [x] Both indexes declared + presence tests
- [x] Order-dependent test fixed
- [x] `npm run ci` green
