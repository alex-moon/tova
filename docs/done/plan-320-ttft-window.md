# Plan: #320 — TTFT rolling mean tracks recent latency

Status: implementing.

## Motivation

`recordTtft` kept an unwindowed lifetime mean — every observation ever counts
equally, so the "current" TTFT per (model, provider) drifted toward historical
truth (GLM/fireworks read 18.45s on 2026-10-15, largely historical queue
overload). Follow-up from #316; the owner approved the windowed-mean approach.

## Decision

**Capped-count windowed mean, not a new field.** The Mongo pipeline already
stores `(ttftMs, ttftSamples)` per provider entry; capping the *effective*
sample count at `W-1` before folding in a new observation gives each new
sample weight `1/W` once the window is full and progressively forgets older
ones — an EWMA equivalent with zero schema change. `W` is env-tunable
(`ROSTER_TTFT_WINDOW`, default 20 — for each (model, provider) series that is
one sample per turn, so ~the last 20 turns).

## Done

- [ ] `recordTtft` capped-count pipeline + env knob
- [ ] DB-backed test (forgetting behaviour, samples cap)
- [ ] `npm run ci` green
