# Plan — #293 Workspace retrieval: keyword / BM25 ranking (RAG step 1)

Issue: [alex-moon/tova#293](https://github.com/alex-moon/tova). Epic: #251.
Follow-up to #253 (workspace memory) and #289 (gate/retrieval eval harness).
Sibling follow-up: #294 (embeddings — the semantic half).

## Motivation

Retrieval today is in-process lexical overlap over a **bounded recent pool**
(`scoreSlice` / `pickTopSlices` in `apps/server/src/services/workspaceRetrievalService.ts:97`).
Two limits, quoted from the ticket:

1. the keyword score is naive — no IDF, no length normalisation — so common terms
   dominate and rare/important terms do not;
2. the bounded recent pool makes an **old relevant chat unreachable by
   construction** — no amount of scoring fixes a candidate that was never fetched.

BM25 addresses (1); searching the whole user corpus rather than the recent window
addresses (2). The #289 harness (`docs/plan-289-gate-evals.md`) already provides the
evidence path: stage-2 retrieval hit-rate by slice ID, with `out-of-pool` and
`paraphrase` scenarios deliberately encoded as the current baseline's failures.

The ticket's own measurement ask is explicit and is the acceptance bar: re-run #289
before and after, expect **retrieval hit-rate up** (especially out-of-pool), and
**report all three stages, not just hit-rate**, noting any precision tradeoff.

## Current behaviour (verified this pass)

- **Score.** `scoreSlice` (`workspaceRetrievalService.ts:97`) = `overlap * 10 +
  max(0, 5 - ageDays)`, hard floor at zero overlap. It is **impure** (reads
  `Date.now()` at `:104`), which is why it cannot be reused as a pure BM25 term and
  why the replacement must stay clock-free. `pickTopSlices` (`:108`) maps → filters
  `score > 0` → sorts by score → slices `n = MAX_SLICES (6)`. No IDF, no
  document-length normalisation. Recency can only reorder equals.
- **Tokeniser.** `promptWords` (`:63`) lowercases, splits on `/[a-z0-9']+/g`, and
  filters to `length > 1` minus `STOPWORDS` (`:38`). It returns a **`Set`**
  (deduplicated), so it cannot express term frequency; it is consumed by
  `matchSnippet` (`:127`) and `corpus.test.ts:30`.
- **Corpus.** `collectWorkspaceSlices` (`:228`) reads the newest `MESSAGE_POOL = 200`
  sessions by `lastMessageAt` (`:234-238`) and the newest 200 `role:'user'` messages in
  those sessions (`:246-254`), plus assets (`ASSET_POOL = 50`, `:255-265`) and tasks
  (`TASK_POOL = 50`, `:266-271`). A chat older than the window is never a candidate.
  Ordering of the read is irrelevant to scoring; only the `at` field matters (tiebreak).
- **Ownership / contracts.** Ownership is session-first by construction; `deletedAt:
  null` excludes soft-deleted chats; `excludeMessageId` / `excludeAssetId` drop the
  current turn's own message/attachment; `ephemeral: { $ne: true }` excludes ZDR assets;
  `BLOCK_CAP = 1200` bounds the rendered block.
- **Gate.** The kill switch is checked in the chat route, not the retrieval service:
  `enrichmentBlocksFor` (`apps/server/src/routes/chat.ts:566`) only calls
  `retrieveWorkspaceBlock` when `votes.workspace && isWorkspaceMemoryEnabled()`
  (`:580`). `config.workspaceMemory.enabled` (`config/index.ts:106`) defaults off. The
  retrieval service is called from exactly two places (`retrieveWorkspaceBlock` and
  `retrieveWorkspaceSlices`) and both are reached only past that gate — so ranking
  changes cannot alter flag-off behaviour.
- **Index gap.** `Message` declares **no indexes**; there is no `messages.sessionId`
  index. The #226 migration
  (`apps/migrations/src/20261007000000-session-last-message-at.ts:16`) explicitly
  deferred `{ sessionId: 1, timestamp: 1 }` as the follow-up this ticket closes. The
  hot chat-history reads already sort by `sessionId` + `timestamp`
  (`chat.ts:825`, `chat.ts:1463`), so the index pays for more than this read.
- **Eval corpus.** `MEMORY_SCENARIOS` (`apps/server/src/evals/memory/corpus.ts:72`)
  encodes `direct`, `paraphrase` (asserted to share **no** content word, `corpus.test.ts:30`),
  `file`, `task`, `deleted-seed`, and `out-of-pool` (`poolFill: 210`,
  `expectSurfaced: false`). `memorySource.test.ts:51` pins "does not surface a seed
  buried beyond the bounded pool" as the baseline #293 is measured against.
- **Baseline numbers** (#289, `docs/plan-289-gate-evals.md:68`): stage 1 precision 100% /
  recall 100% / fireRate 50% (n=8); stage 2 expectedMet 83.3% / surfaced 50% (n=6);
  `direct` 1/1, `file` 1/1, `task` 1/1, `paraphrase` 0/1, `deleted-seed` 0/1,
  `out-of-pool` 0/1.

## Decisions

1. **In-process BM25 first (ticket's recommended call).** Personal scale makes a
   full-corpus scan affordable; it needs no new infra or Atlas tier, and it runs in
   CI/local — Atlas `$search` does not exist in `mongodb-memory-server` or local
   `mongod`. Atlas Search remains a later swap, contained because the ranker stays
   behind the pure interface. (The cost assumption this rests on is challenged in
   "Assumptions and risks".)
2. **Keep the pure ranking seam, swap its internals.** `pickTopSlices(prompt, slices, n)`
   keeps its name and signature (so `buildWorkspaceBlock:164` and
   `retrieveWorkspaceSlices:336` are untouched) but computes BM25 over the slice set it
   is handed. `scoreSlice` is **removed**: BM25 is corpus-relative (IDF, `avgdl`), so a
   single-document score function cannot express it. The ranker stays pure — no Mongo,
   no `Date.now()` — so it remains unit-testable.
3. **BM25 parameters and formula, recorded.** Export `BM25_K1 = 1.2` and `BM25_B = 0.75`
   (standard defaults; recorded so a future tuning change is a diff). Query term
   frequency is 1 per distinct query term (the prompt is treated as a set). IDF uses the
   non-negative form `ln(1 + (N - df + 0.5) / (df + 0.5))` so a ubiquitous term still
   scores slightly positive rather than negative, and the existing `score > 0` filter
   keeps its "no overlap → not surfaced" meaning.
4. **Tokenizer gains multiplicity without changing `promptWords`'s contract.** Add a
   `tokenize(text): string[]` helper (same `WORD_PATTERN` + `STOPWORDS` + `length > 1`
   rules) returning terms **with multiplicity** for document term frequency.
   `promptWords` becomes `new Set(tokenize(...))`, preserving its exact `Set` behaviour
   for `matchSnippet` and `corpus.test.ts`. IDF/`avgdl` are computed over the slices
   passed to `pickTopSlices`, i.e. the assembled corpus (chat + file + task).
5. **Tiebreak is explicit and total.** Sort by BM25 score desc, then `at` desc, then
   `id` asc. Recency is a tiebreak only (preserving #253's invariant), and the `id`
   fallback makes ordering deterministic regardless of engine sort stability.
6. **Search the whole chat corpus; drop the recency window.** `collectWorkspaceSlices`
   fetches **all** non-deleted sessions for the user (drop `.sort({ lastMessageAt: -1
   }).limit(MESSAGE_POOL)`, `:234-238`) and all `role:'user'` messages in them (drop
   `.sort({ timestamp: -1 }).limit(MESSAGE_POOL)`, `:246-254`). `MESSAGE_POOL` is
   deleted. The bound becomes the user's own corpus (personal scale), not recency.
   Assets and tasks keep explicit caps for now — the ticket's stated failure is the chat
   window (see Open questions 2).
7. **Close the #226 deferred index gap with a migration.** Add
   `apps/migrations/src/<ts>-message-session-index.ts` creating
   `{ sessionId: 1, timestamp: -1 }` on `messages`, existence-checked with a `down`,
   following the #226 pattern. Rationale: #226 named exactly this index as its deferred
   follow-up, and the Session model carries the explicit "the migration owns it" stance.
   The repo has **no single convention** — 16 indexes are declared on models
   (`Asset`, `Task`, `TaskEvent`, …) and rely on Mongoose `autoIndex` — so the
   alternative is a `messageSchema.index(...)` one-liner; the migration is chosen here
   for parity with #226. Migrations are auto-discovered by the glob in
   `apps/migrations/src/index.ts`, so there is **no registry to update**.
8. **Preserve every existing contract.** Ownership session-first, `deletedAt` exclusion,
   `excludeMessageId` / `excludeAssetId`, `ephemeral` exclusion, `BLOCK_CAP`, and the
   flag gate all stay. Ranking changes cannot alter flag-off behaviour because the gate
   lives in the route, not the service (verified above).
9. **Update the #289 corpus expectation that the change invalidates.** `out-of-pool`
   flips `expectSurfaced: false → true` (it is now reachable, which is the point), and
   `memorySource.test.ts` flips with it. `deleted-seed` stays `false` (still excluded by
   `deletedAt`). `paraphrase` **stays `false`** — BM25 is lexical and the corpus asserts
   the paraphrase shares no content word (`corpus.test.ts:30`), so no lexical ranker can
   surface it; that is #294's job. This is stated plainly rather than promised away (see
   Open questions 1, which is a scope question, not a dependency of this plan).
10. **Flag-off is unchanged and asserted.** No retrieval code runs when
    `WORKSPACE_MEMORY_ENABLED` is unset; add an explicit route test asserting the chat
    path injects no `<user:workspace>` block and does not call `retrieveWorkspaceBlock`.

## BM25 specification (the ranker, pinned before coding)

For a query `q` and document `d` in a corpus of `N` slices:

```
score(q, d) = Σ_{t ∈ distinct(q)} idf(t) · (tf(t,d) · (k1 + 1))
              / (tf(t,d) + k1 · (1 - b + b · |d| / avgdl))

idf(t) = ln(1 + (N - df(t) + 0.5) / (df(t) + 0.5))     # non-negative
avgdl  = (Σ_d |d|) / N                                   # mean token count
|d|    = number of tokens in d after tokenize()
k1 = 1.2, b = 0.75
```

- `df(t)` counts documents containing `t` (set membership, not multiplicity).
- Query terms are distinct; query `tf` is fixed at 1.
- **Zero overlap ⇒ score 0**, so the `score > 0` filter and "recency alone cannot
  surface an unrelated slice" invariant are preserved.
- **Edge cases the code must handle:** empty corpus (`N = 0`) → no picks; empty query
  (`tokenize` yields `[]`) → no picks; `avgdl = 0` (all-empty docs) → no picks / guard
  the division; a query term absent from every doc contributes nothing.

Worked example used in tests (N=3; A=`budget`, B=`budget move`, C=`move`; q=`budget`;
avgdl=4/3): A ≈ 0.5236, B ≈ 0.3902, C = 0. This doubles as the length-normalisation case.
IDF case (N=3; A=`rare`, B=`common`, C=`common`; q=`rare common`): A ≈ 0.981 > B ≈ 0.470.

Tests pin **invariants and one hand-computed exact case**, not floating-point magic
values on large corpora (brittle): rare-term > common-term; shorter doc > longer doc at
equal tf; zero overlap dropped; equal scores tiebreak `at` desc then `id` asc; `n` cap
holds; empty query/corpus safe; repeated calls deterministic.

## Scope

In: BM25 ranker + tests; whole-chat-corpus read; the `messages.sessionId` migration;
the #289 `out-of-pool` expectation update; the flag-off route assertion; the
before/after measurement.

Out: embeddings / semantic paraphrase (#294); Atlas Search; query expansion, stemming,
or synonym dictionaries; persisting memory-eval metrics to a rollup; the
`WORKSPACE_MEMORY_ENABLED` go/no-go; changing the file/task caps (Open question 2).

## Done (each item is one safe commit)

- [x] **1. BM25 core (pure).** In `workspaceRetrievalService.ts`:
  - add `BM25_K1`/`BM25_B` exports and `tokenize(text): string[]`; redefine
    `promptWords` as `new Set(tokenize(...))` (same filtering, `Set` contract kept);
  - rewrite `pickTopSlices` to build `docs = slices.map(s => tokenize(s.text))`, compute
    `N`, `avgdl`, and `df` once, then score each slice with the formula above, keeping
    the map → `filter(score > 0)` → sort → `slice(0, n)` shape;
  - sort comparator: `score` desc, then `at` desc, then `id` asc.
  - Unit tests (in `workspaceRetrievalService.test.ts`, new `describe('bm25')`): the
    IDF, length-normalisation, zero-overlap, exact-value, tiebreak, `n`-cap,
    empty-query/corpus, and determinism cases listed above.
- [x] **2. Retire `scoreSlice`; keep callers intact.** Delete `scoreSlice` and its
  `describe` block (`workspaceRetrievalService.test.ts:47-62`); drop it from the import
  (`:14`). Re-run the existing `pickTopSlices` tests (`:64-78`) — the `['a','c']`
  expectation still holds under BM25 (verified by hand); no changes to
  `buildWorkspaceBlock` / `retrieveWorkspaceSlices` call sites.
- [x] **3. Whole-corpus read.** In `collectWorkspaceSlices`: remove
  `.sort({ lastMessageAt: -1 }).limit(MESSAGE_POOL)` on the session query (`:234-238`)
  and `.sort({ timestamp: -1 }).limit(MESSAGE_POOL)` on the message query (`:246-254`);
  delete the `MESSAGE_POOL` constant (`:78`). Keep `ASSET_POOL`/`TASK_POOL`. Rewrite the
  module comment (`:193-227`) to state the new bound (the user's whole non-deleted chat
  corpus; assets/tasks still pool-bounded) and why the message sort is no longer needed.
- [x] **4. Message index migration.** Add
  `apps/migrations/src/20261014120000-message-session-index.ts` (class
  `MessageSessionIndex`): `up` existence-checks `{ sessionId: 1, timestamp: -1 }` on
  `messages` and creates it if absent; `down` drops it inside a try/catch. No registry
  edit (glob discovery). `npm run db:migrate` runs it locally.
- [x] **5. Reachability regression test.** In `workspaceRetrievalService.test.ts` (Mongo
  block), seed one matching chat message, insert >200 newer filler messages in the same
  user's sessions, and assert `retrieveWorkspaceBlock` still surfaces the seed. (This is
  the ticket's core regression; the flipped #289 `out-of-pool` test in step 6 covers the
  same ground end-to-end — keep both, the service test is the tighter one.)
- [x] **6. #289 corpus + test update.** In `corpus.ts`: flip
  `retrieval-out-of-pool.expectSurfaced` to `true` and rewrite its `description`
  (now reachable). In `memorySource.test.ts`: rename the assertion to "surfaces a seed
  buried beyond the old bounded pool" and expect `true`. Leave `paraphrase` (`:43-45`)
  and `deleted-seed` (`:47-49`) assertions and the `corpus.test.ts` invariants unchanged
  (only `out-of-pool` still carries `poolFill`).
- [x] **7. Flag-off route assertion.** In `apps/server/src/routes/chat.test.ts` (or
  `chat.stream.test.ts`), add a case with `WORKSPACE_MEMORY_ENABLED` unset and
  `enrichmentVotes` returning `{ workspace: true }`: assert the system instructions do
  **not** contain `<user:workspace>` and `retrieveWorkspaceBlock` was not called.
- [x] **8. Measurement.** Run `npm run evals:memory` on `main` (baseline, #289) and on
  the branch; fill the table below with stage-1 and stage-2 (overall + per-category)
  deltas; note the precision tradeoff and that stage 3 did not run.
- [x] **9. Quality gate.** `npm run ci` green (exit 0).

## Measurement plan (fill in after implementation)

| Stage | Baseline (#289) | After #293 |
| --- | --- | --- |
| 1 — gate precision / recall / fireRate | 100% / 100% / 50% (n=8) | 100% / 75% / 37.5% (n=8) — see note |
| 2 — retrieval expectedMetRate / surfacedRate | 83.3% / 50% (n=6) | 83.3% / **66.7%** (n=6) |
| 2 — by category | direct 1/1, file 1/1, task 1/1, paraphrase 0/1, deleted-seed 0/1, out-of-pool 0/1 | direct 1/1, file 1/1, task 1/1, paraphrase 0/1, deleted-seed 0/1, **out-of-pool 1/1** |
| 3 — helpfulness (judge) | not run | not run (not wired) |

**Delta.** Retrieval surfacedRate **50% → 66.7% (+16.7pp)**; the only mover is
`out-of-pool`, now 1/1 (the seed buried behind 210 newer messages is reachable). The
whole-corpus read is the cause, not the score change. `expectedMetRate` is flat at 83.3%
because the flipped `out-of-pool` expectation now matches its (surfaced) observation.

`paraphrase` stays a miss as predicted — BM25 is lexical and the corpus asserts zero
shared content words, so it is #294's case. `deleted-seed` stays excluded by `deletedAt`.

Stage 1 is a separate classifier (the gate model, not the retrieval ranker), so #293
cannot affect it; its rerun observed 100% / 75% / 37.5% (`gate-move-decision` missed) versus
the #289 baseline 100% / 100% / 50%. That is the stochastic aux model, not this change —
stage 1 never calls the retrieval service (the vote gates the call, per decision 8). The
retrieval-stage numbers are the deterministic part of the suite and are exact.

**Precision tradeoff.** Not measurable with this corpus: it has no labelled distractor
seeds, so "fraction of surfaced slices that are relevant" cannot be computed. Reading
`surfacedIds` per scenario, the wider corpus surfaced no extra near-miss slice in any
scenario (the expected slice was the only relevant candidate seeded, and no non-seed
slice appeared in the picks). Reported qualitatively, not as a precision number (Open
question 4). The `out-of-pool` run still seeds 210 filler turns, so the result proves the
seed is reachable, not that filler was ignored.

## Assumptions and risks (challenged)

- **"Personal scale makes a full-corpus scan affordable" is unquantified.** Removing the
  pool makes every retrieval turn read, tokenise, and BM25-score the user's *entire*
  chat history. There is no latency budget, no corpus-size measurement, and no guard.
  This is the largest risk in the plan (Open question 3).
- **The `$in`-by-session read is only as cheap as the index.** With thousands of
  sessions, the `sessionId: { $in: [...] }` array grows with the corpus. The migration
  in step 4 makes the per-session lookup indexed, but the query document itself is still
  O(sessions).
- **Mixing heterogeneous docs in one BM25 corpus.** File slices are far longer than
  chat turns, so they inflate `avgdl` and shift IDF for chat terms. `b = 0.75` mitigates
  but does not remove this (Open question 5).
- **`out-of-pool` still seeds 210 filler messages** on every eval run; after the flip it
  only proves the seed is reachable, not that filler was ignored. Keep it, but note the
  run cost.
- **Removing `scoreSlice` is a public-API change** (`workspaceRetrievalService.ts` is
  imported by the eval harness). Verified the only importers are the two call sites and
  the test, so the blast radius is contained.

## Open questions

1. **Paraphrase expectation (scope, conflicts with the ticket body).** The ticket says
   "expect retrieval hit-rate up, especially the out-of-pool **and paraphrase** cases",
   and the `memorySource.test.ts:40-45` comment implies BM25 should flip paraphrase. It
   cannot: `corpus.test.ts:30` pins that the paraphrase query shares **no** content word
   with its seed, and BM25 is lexical. Either the paraphrase expectation belongs to
   #294, or #293 is expected to add lexical expansion (stemming/synonyms) beyond BM25 —
   which is currently out of scope. The plan's default is "leave paraphrase as a miss";
   confirm the owner accepts that before treating the #289 delta as complete.
2. **File/task caps.** "Whole user corpus" could also mean removing `ASSET_POOL`/
   `TASK_POOL` (currently recency-ordered by `_id`/`updatedAt`), which have the same
   "old item unreachable" defect as the chat window. The plan leaves them as explicit
   caps because the ticket's stated failure is the chat window. Confirm whether they
   should widen too.
3. **Full-corpus cost / latency budget (NEW).** The message read is now unbounded. What
   corpus size and per-turn latency are acceptable, and is a backstop wanted? Any cap
   ordered by recency would reintroduce the very window this ticket removes, so a
   backstop would need a non-recency ordering (or none at all). Not pre-optimised; flag
   for a measurement before shipping wide.
4. **Retrieval precision metric.** The ticket says "watch the tradeoff … lower gate
   precision", but retrieval cannot change the gate (stage 1 is a separate classifier),
   so "retrieval precision" is presumably meant — and the corpus has no labelled
   distractors to compute it. Do we extend the corpus with distractor seeds, or report
   hit-rate plus a qualitative near-miss note?
5. **BM25 corpus composition (NEW).** Should chat, file, and task slices share one BM25
   corpus? Their length distributions differ by orders of magnitude, so `avgdl`/IDF are
   dominated by whichever kind is longest. Alternatives: per-kind corpora, length caps
   on file text, or accept the skew. Left as one corpus pending evidence.
6. **Score floor.** Should BM25 gain a minimum-score threshold to suppress near-miss
   slices? Evidence-driven: only if the widened corpus actually shows noise; not
   pre-optimised here.
7. **Title as document text.** Chat/task titles are display-only today (scoring is
   text-only). Should titles contribute to the BM25 document? Left unchanged to avoid an
   unmeasured recall shift.

## Follow-ups

- #294 (embeddings) for the paraphrase / semantic gap.
- Persist memory-eval metrics (blocked on the #289 rollup-shape decision).
- Atlas Search BM25 swap once scale justifies it (the pure interface contains the swap).
- Revisit Open questions 2, 3, 5 once the widened corpus has a measurement.
