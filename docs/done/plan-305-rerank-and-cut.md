# Plan — #305 Rerank-and-cut stage

Vague queries surface weak matches: BM25 has no meaningful absolute threshold
(corpus-relative IDF/avgdl), the stopword list is tiny, and bare-deictic
prompts ("And that one as well?") match on high-frequency leftovers. The
standard fix is contextual compression: retrieve liberally, then absolutely
grade each candidate against the query and cut — including cutting everything,
which yields an empty block and a clean refusal.

## Model decision (the issue's premise was stale)

#305 named `BAAI/bge-reranker-v2-m3` via DeepInfra — DeepInfra no longer serves
it (404 "Model is not available"; their model catalog hosts no reranker). The
Qwen3-Reranker family **is** served with the same
`{queries, documents} → {scores}` contract. The calibration probe picked
**`Qwen/Qwen3-Reranker-0.6B`**: crispest absolute separation of the three sizes
(relevant ≈ 0.98 vs irrelevant ≈ 0.0002 on an easy pair), lowest price/latency,
and the candidate set is ≤ 12 docs.

## Calibration (probe over the #289 corpus, 2026-10-15)

`scripts/_calibrate-rerank.ts` (temp, removed) graded every scenario's
query → expected seed (positives), query → foreign/other seeds (negatives),
and the bare-deixis gate prompts → corpus docs:

- relevant pairs: median **0.9985** (true-irrelevant ≤ 0.0009)
- bare-deixis pairs: **max 0.0036** — all far under any sane bar
- paraphrase pairs grade weakly (0.0006–0.07): the slice alone cannot resolve
  the referent ("She is a doctor…" vs "What does my partner do?"). No absolute
  threshold separates them from the deixis band — a known trade-off, recorded
  here: one locally-surfaced paraphrase case falls below the bar.

**`RERANK_CUT = 0.005`** sits in the decade gap above "irrelevant"/"deixis" and
below every confidently-relevant pair (≥ 0.0087). Scores are probabilities, so
the bar is absolute and corpus-independent (unlike BM25).

## Integration

- `rerankerService.ts`: the DeepInfra client — mirrors `embeddingService.ts`'s
  thin-fetch stance; **never throws** — every failure degrades to `null`.
- `rerankAndCut`: grades the full fused set (BM25 ∪ vector, ≤ ~12 candidates;
  the doc text is `title\ncontent` — #309's metadata matters for reranking
  too), drops sub-threshold candidates, orders the rest by relevance. Empty
  after cut → `[]` → `renderBlock` renders no block (the refusal path).
- `rankWorkspaceSlices`: the stage shares the workspace-memory kill switch —
  flag off ⇒ the pre-#305 fused ranking exactly, no reranker call. A `null`
  rerank (provider down, key missing, timeout) degrades to the un-cut fused
  ranking — also exactly pre-#305.

Deferred (issue optionals, not needed for the cut to work): the absolute
vector-stage similarity floor and the IDF-band backstop.

## Verification

- Unit: cut/empty-after-cut/degradation/reorder behind the pure seam; the
  client's null-on-failure contract (never a live call in tests).
- `npm run evals:memory`: gate/stage-2 deltas + the empty-after-cut rate.
- `npm run ci` green.
