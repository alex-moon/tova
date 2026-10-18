# Plan 393 — Workspace-embedding correctness batch

## Motivation

[Issue #393](https://github.com/alex-moon/tova/issues/393), from the #382 audit: the
workspace/memory stack has correctness and cost defects — a hash-parity break that
re-embeds whole corpora, a factory-reset purge gap that leaks content-derived vectors,
an ANN query with zero exploration headroom, and several unbounded reads that map
corpus size onto per-turn cost.

## Decisions

1. **Title-fold parity: fold only for `file`, in the planner.** Ingest
   (`workspaceSliceText`) is the canonical writer and folds the title only for
   `kind: 'file'`; backfill (`planEmbeddingWrites`) folds for every kind, so for
   titled chat/task slices the two paths hash different text and every backfill
   re-embeds the whole chat/task corpus. Fix in the planner (fold only for `file`);
   no production row is invalidated (file hashes keep matching; chat/task hashes
   become equal to what ingest wrote).
2. **Purge: add the collection, close the in-process race with a drain.**
   `purgeAllUserData` sweeps `WorkspaceEmbedding` in its `Promise.all`. For the
   fire-and-forget embed race: `workspaceEmbeddingIngest` keeps a per-user registry
   of in-flight `embedWorkspaceSlice` promises and exports `drainUserEmbeddings(uid)`;
   the purge drains before the Mongo sweep and once more after it (catches enqueues
   that land mid-sweep). A truly concurrent new turn after the final drain is out of
   scope — that is new post-reset content for a still-logged-in user, not leaked data.
   Cross-instance races are out of scope (same stance as the audit).
3. **ANN headroom: dedicated multiplier.** `numCandidates = limit * 4` (new
   `VECTOR_NUM_CANDIDATE_MULTIPLIER`), reusing the existing floor logic only for
   `limit`. Atlas gets real exploration over the result window instead of
   `numCandidates === limit`.
4. **Rerank input: cap count and per-doc text.** New constants
   `RERANK_MAX_CANDIDATES = 24` (graded candidates, taken in RRF order) and
   `RERANK_DOC_CHARS = 2000` (rerank doc text only; returned slices keep full text).
   `candidateCount` reports the graded count (`min(fused, cap)`) so the eval
   diagnostics keep their meaning. Degradation (reranker null) still returns the
   full fused ranking, unchanged.
5. **Corpus read cap: newest-500 window for chat messages.** `Message.find` in
   `collectWorkspaceSlices` gets `.sort({ timestamp: -1 }).limit(CHAT_POOL)` with
   `CHAT_POOL = 500` — generous (the #293 regression seed at 211 filler messages
   still retrieves) and O(1) per turn instead of O(history).
6. **Dim-aware skip: filter at the query, not in the hash.** The audit suggests
   folding dim into `embeddingTextHash`; that changes every digest and triggers a
   one-time full re-embed of every corpus on deploy. Equivalent protection without
   the cost: `embedWorkspaceUser` queries existing rows with
   `dim: config.embeddings.dim`, so a stale-dim row never satisfies the skip lookup
   and is re-embedded (the unique `{kind, sourceId, model}` upsert then overwrites
   it). Write-side dim validation already exists (`embeddingService.ts` rejects
   vectors whose length differs from `config.embeddings.dim`).
7. **Index: `{ model: 1, userId: 1 }`** on `WorkspaceEmbedding`, matching the
   `embedWorkspaceUser` row query (now including the dim filter).
8. **Vector search: real deadline + honest label.** `withTimeout` gains a label
   parameter (default `'conversion'`, so existing call sites and logs are unchanged);
   the vector path passes `'workspace vector search'`. `defaultVectorSearch` sets
   `maxTimeMS` on `$vectorSearch` from the same budget so Atlas stops the query
   instead of racing an abandoned cursor.

## Done

- [x] `planEmbeddingWrites` folds the title only for `kind: 'file'`; comment on
      `EmbeddableSlice.title` updated; parity test for titled chat/task slices.
- [x] `purgeAllUserData` sweeps `WorkspaceEmbedding`; in-flight ingest registry +
      `drainUserEmbeddings`; purge drains pre-sweep and post-sweep; tests.
- [x] `numCandidates` gets headroom (`limit * 4`); cement tests updated.
- [x] Rerank capped (24 candidates, 2000 chars/doc); `candidateCount` = graded
      count; tests.
- [x] Chat corpus read capped (newest 500, `CHAT_POOL`); existing regression test
      still green.
- [x] Stale-dim rows never satisfy the skip (`dim` in the backfill row query); test.
- [x] `{ model: 1, userId: 1 }` index on `WorkspaceEmbedding`.
- [x] `withTimeout` label parameter; vector path labeled; `maxTimeMS` on
      `$vectorSearch` (via the aggregate's `.option`, the typed seam); test pins
      the param.
- [x] `npm run ci` green.

## Follow-ups

- A dim change re-embeds rows, but `ensureVectorIndex` never recreates the Atlas
  index, so `numDimensions` stays at the old value and the vector path degrades to
  BM25 until the index is deleted and recreated. Index lifecycle is infra, not app
  code — flagged here so a dim change is known to need the manual step.
- The purge's race closure is airtight for embeds enqueued up to the second drain's
  snapshot. An enqueue landing after that snapshot but before the final deleteMany
  can still write after it; that content is a live post-reset message (not leaked
  PII), matching the documented out-of-scope stance. Closing it fully would need a
  purge tombstone checked at write time, which drops the embedding for content that
  survives — judged worse than the residual window.
