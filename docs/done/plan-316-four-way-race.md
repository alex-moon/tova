# Plan: #316 — Four-way race

Status: implemented; ready for review (archived per the workflow's ready-for-review trigger).

## Motivation

Today's streaming race (#232) picks ONE primary model by weighted score
(`pickPrimary` — rolling-mean TTFT × price penalty) and races only its two
providers. The pick decides the model from *stale, winner-biased history* before
the turn starts; the race then measures current latency for providers only.
#316: stop guessing — race all four combos (2 models × 2 providers) and let the
first token pick the winner. Design settled with the owner on the ticket
(comment 6192019452).

## Decisions

- **Race the real turn, not the ticket's literal `'y'` probe.** TTFT on real
  turns is dominated by prefill of the actual conversation; a context-free probe
  ranks queue+network only and its ranking doesn't transfer on long sessions. A
  representative probe needs the full context — 4× input cost *plus* a serial
  round-trip. The real turn's first token is the cheapest correct signal: losers
  cost ~4× input tokens (≈ $0.01–0.02/turn at roster prices) and ~zero output.
- **Record TTFT for all four combos, not just the winner.** Input tokens are
  fully billed regardless of abort timing, so each racer records its own
  first-chunk TTFT and only then self-aborts (background, non-blocking). Today
  only the winner's TTFT is recorded — the rolling means were winner-biased.
  Losing racers' first chunks are discarded; the marginal output cost is one
  chunk per loser.
- **Streaming chat path only.** `raceRosterCompletion` (background tasks) keeps
  the weighted-pick + per-model provider race: `createCompletion` cannot cancel
  in-flight calls today, so a flat race there bills up to 4 full completions.
  Follow-up once cancellation is wired.
- **Vision routing gate removed; vision metadata stays.** With MiniMax out of
  the roster, the `hasImage`/vision turn-gating is dead code — removed from
  `rosterModelsForTurn`, `raceRoster`, `pickRosterRoute`, `routeAndStream`, and
  the chat routes' racing call sites (`hasImage` itself survives in chat.ts for
  image-turn building and workspace gating). The `vision` field remains
  descriptive metadata in the ModelRoster schema, admin CRUD, and admin UI —
  the racing data layer (`RosterModel`, `toRosterModel`) stops carrying it.
  Removing the admin badge/column is offered as a follow-up, not this PR.
- **MiniMax dropped from `ROSTER_SEED`.** The seed is the fallback source of
  truth (empty-collection recovery, DB-read failure); leaving MiniMax there
  would put a text-only model into every race once the gate is gone. The
  MiniMax DB row is NOT touched here; the DB is the live source of truth, so
  the row must be `eligible: false` (admin UI toggle) for the race to actually
  be four-way. Local dev flag flipped during verification.
- **Flat race failure semantics.** One combo failing while another wins is
  noise (loser error swallowed, no cool-off) — same as within a winning race
  today. Total failure (every combo fails) cools off every failed combo and
  throws the last non-abort error. The per-model fallback loop and
  `MAX_RACE_ATTEMPTS` remain only on the completion path.
- **`pickPrimary`/weighted score kept** for the completion path and the
  pre-race `meta` prediction (`pickRosterRoute`).

## Changes

- `racingService.ts`: `raceRoster` fires every (model, live provider) combo
  concurrently; first chunk wins; losers record TTFT then self-abort; total
  failure cools off all combos. `hasImage` params dropped throughout
  (`raceRoster`, `raceRosterCompletion`, `pickRosterRoute`, `routeAndStream`,
  `routeAndComplete`).
- `rosterConfig.ts`: `rosterModelsForTurn` loses `hasImage`/vision filtering;
  `RosterModel` loses `vision`; MiniMax dropped from `ROSTER_SEED`;
  `ensureSeed` stops writing it.
- `chat.ts` / `taskSequencer.ts`: drop the `hasImage` racing args.
- Tests: racing flat-race coverage (all combos started, first-token winner,
  loser TTFT recorded, total-failure cool-off, client abort still wins),
  image-restriction tests retired, fixture shapes updated.

## Done

- [x] Flat four-way streaming race + all-combo TTFT recording
- [x] Vision gate removed from the racing path
- [x] MiniMax out of the seed (+ migration); local DB already `eligible: false`
- [x] `npm run ci` green

## Evidence (local DB, 2026-10-15)

The winner-bias and staleness the flat race fixes, read off the local roster:

- `zai-org/GLM-5.3-Flash` deepinfra: mean 5.67s / 33 samples; fireworks: mean
  18.45s / 31 samples (unwindowed means carry historical queue overload).
- `deepseek-ai/DeepSeek-V4.1-Flash` deepinfra: 6.95s / 1 sample; fireworks:
  **zero samples** — under the old pick (GLM wins pre-pick every turn) DeepSeek
  was never raced at all, so it could never be observed.

## Follow-ups

- Completion-path cancellation, then extend the flat race to background tasks.
- Admin UI vision badge/column removal if wanted (metadata only).
- Watch `tova-dev` traces: all-race turns now tag every combo `race:roster`.
