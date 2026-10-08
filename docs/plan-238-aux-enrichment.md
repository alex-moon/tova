# Plan — #238 Aux calls + enrichment pass after the guard classifier retires

## Motivation

Part of the #232 routing replacement (fixed roster + hedged provider racing).
The tier guard classifier is gone (#233), but the **auxiliary** LLM calls that
shared its env vars (`ROUTER_SMALL_MODEL`, `ROUTER_GUARD_MODEL`) still read
them:

| Caller | Env read today | Purpose |
|---|---|---|
| `titleService.ts:4` | `ROUTER_SMALL_MODEL` | chat title |
| `entityExtractionService.ts:16` | `ROUTER_SMALL_MODEL` | entity graph (#138) |
| `followupService.ts:4` | `ROUTER_GUARD_MODEL` | follow-up suggestions |
| `metricsService.ts:6` | `ROUTER_GUARD_MODEL` | prompt-dimension classification |

Those env vars belong to the deleted tier router; they need a real model source.
Separately, the guard's **enrichment** role (the `files` AUX vote that injected
the file-library index) was dropped from the chat routes by #233 — raced turns
inject no library index today. This ticket relocates the aux calls and rebuilds
enrichment as a dedicated pass.

Base branch is `epic/roster` (see `docs/plan-roster.md`), not `main`.

## Owner direction applied (from #232)

- Small models are retired **for chat routing only**. The owner kept a cheap,
  latency-insensitive aux model as "still defensible" for titles/metrics/etc.
  **Decision (OQ1): a single fixed aux model, default `openai/gpt-oss-20b` on
  `groq`** — the retired guard model, kept solely as the aux model. One model
  for all four callers; simplest, and matches the pre-#232 behaviour byte-for-byte
  on the wire.
- The guard's enrichment role is **kept**. **Decision: enrichment stays an LLM
  call** (OQ2) — the owner deleted the old key-phrase rules in #169 precisely
  because natural-language judgement is the LLM's job. The `files` vote is
  preserved verbatim; **no new signals are invented** (OQ3 is a concrete
  list the owner has not supplied yet — expansion is deferred, see Follow-ups).
- **Decision (OQ5): enrichment is serial but hard-timeout-bounded.** A truly
  parallel pass cannot inject the block into the *same* turn's prompt (the race
  consumes `messages` before the aux call can return), and applying a stale
  vote to a later turn would be worse than applying none. So the pass runs
  before assembly — exactly like the existing entity-graph block — but is
  bounded by `ENRICHMENT_TIMEOUT_MS` (default 1500) so a slow aux call degrades
  to "no block" instead of delaying the turn. Worst-case added latency is the
  timeout, not the model's full round-trip.

## Decisions

1. **New aux model source.** Add `AUX_MODEL` (default `openai/gpt-oss-20b`) and
   `AUX_PROVIDER` (default `groq`) to `config/index.ts`. All four aux services
   read this one source; `ROUTER_SMALL_MODEL`/`ROUTER_GUARD_MODEL` inline reads
   are removed. Non-tagged aux calls already default to `groq` in
   `inferenceService`, so the provider default is consistent.
2. **`enrichmentService.ts`** is the seed of the "first tiny fast pass". It owns
   the `files` vote prompt and a tolerant parser (ported from the retired
   `guardFilesVoteFromReply`/`parseGuardVotes`), returning a boolean. Runs on
   the aux model. Never throws — enrichment is never load-bearing.
3. **Bounded serial injection.** The chat routes await the enrichment pass
   before assembling the system prompt (same shape as the entity-graph block
   today), but the pass is wrapped in a timeout (`ENRICHMENT_TIMEOUT_MS`,
   default 1500) so a slow or hung aux call degrades to "no index" rather than
   blocking the turn.
4. **Image turns.** Enrichment is text-only and **skipped when the turn carries
   pixels** (OQ4) — the old guard skipped images, and a VLM aux pass is a
   separate investment. Image turns inject no library index, as today.
5. **ZDR turns** keep their "write nothing" contract; enrichment is read-only
   (library index) so it may run, but the scope keeps behaviour identical to
   today: no index on ZDR (deferred with expansion).

## Done

- [x] `AUX_MODEL` / `AUX_PROVIDER` config accessors (+ `ENRICHMENT_TIMEOUT_MS`).
- [x] Four aux services read the aux source; `ROUTER_*` inline reads removed.
- [x] `enrichmentService.ts` (files vote prompt + parser + bounded pass),
      unit-tested (10 cases: parser, vote, inject, no-vote, empty, error,
      kill switch, timeout).
- [x] Bounded-serial enrichment wired into both chat routes; library index
      injected; skipped on image and ZDR turns.
- [x] Aux tests updated for the env rename; route tests stub enrichment.
- [x] `npm run ci` green.

## Follow-ups

- **Enrichment expansion (OQ3)** — the owner's "expand it" needs a concrete
  signal list (entity-graph relevance, tool-need prediction, ZDR/multilingual
  hints). Not built here; raise once the owner supplies the list.
- **Deterministic vs LLM signals (OQ2)** — kept LLM for now; revisit if latency
  or reliability of the aux pass proves poor.
- ZDR enrichment and image-turn enrichment are deliberately unchanged.
