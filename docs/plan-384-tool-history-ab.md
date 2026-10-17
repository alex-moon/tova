# Plan — Tool-history A/B probe (#384)

## Motivation

The same roster models (GLM 5.3 Flash, DeepSeek V4.1 Flash) are reliable tool users in
OpenCode but narrate tool use instead of invoking it in Tova — the honesty guard (#371)
patrols the symptom. Hypothesis: replayed history shows prior tool use as prose claims
plus a system-added `[tools used: …]` line, with no structured `tool_calls`/`tool`
messages, so the transcript teaches narrate-over-invoke. The #360 imitation incident is
the same mechanism at output time.

## Decisions

- **Probe before building.** A/B the real "Review blog draft" session (the #382
  reconstruction; the natural experiment where fabrication happened in the wild).
- **Arm A** — today's format, built by the real route builders.
- **Arm B** — same history, but assistant turns with tools become `tool_calls` +
  `role: "tool"` result messages, results rehydrated in full (~2.6 KB draft body
  rebuilt from the transcript's own quotes; Spaces content is not in the local dump).
- **Arm C** (added after B's first run) — same as B with read results truncated to
  400 chars, to separate "structure" from "content visible in history".
- **Metric** — per arm × model × 5 reps: real tool calls executed vs claim-shaped
  replies (reuse `classifyAssistantTurn`).
- **No userId on probe calls.** Tools answer `unavailable`, so the probe can never
  write to the real library; invocation is decided before the call, so the invocation
  metric is clean. Trade-off: post-failure recitation inflates flag rates in every arm
  (the guard counts reciting remembered results as a claim).
- **Fireworks backends are dead from this environment** (`NOT_FOUND`, both models,
  consistent) — all successful reps ran on deepinfra. Probe runs pass no trace context,
  so they stay out of the session's LangSmith thread.

## Verdict (5 reps × 3 arms × 2 models, deepinfra)

| model | A invoke/flag | B invoke/flag | C invoke/flag |
|---|---|---|---|
| GLM-5.3-Flash | 5/5 · 1 | 5/5 · 1 | 5/5 · 1 |
| DeepSeek-V4.1-Flash | 3/5 · 3 | 3/5 · 4 | 2/5 · 3 |

- **Structured tool history does not fix narrate-over-invoke.** Arms B/C moved
  DeepSeek's invocation rate nowhere (3/5 → 3/5 → 2/5) and left GLM at ceiling
  (15/15). The hypothesis is refuted for the invocation failure.
- **The lever is model-level, not history-level.** GLM invoked in every rep of every
  arm; DeepSeek skipped ~40% regardless of shape. Production's flagged fabrication
  (#382 session, 17:59) was DeepSeek-V4.1-Flash on deepinfra — the probe and prod
  agree on the offender.
- Flag rates in-probe are inflated by the no-userId design (models narrate remembered
  content after an `unavailable` read); treat them as relative, not absolute.
- Structured replay (persisting tool calls/results) stays parked: no evidence it buys
  invocation reliability, and B's full results actively hand the model content to
  "read back" from the transcript instead of re-reading the file.

## Done

- [x] Ticket + branch
- [x] Probe script (`scripts/eval-tool-history-ab.ts`)
- [x] Run + scoreboard
- [x] Verdict recorded here; findings posted to #384

## Follow-ups

- Prompt-delta probe for DeepSeek: Tova's persona/identity system prompt vs an
  OpenCode-style tool-first prompt, same session — the harness delta the A/B could not
  discriminate.
- Routing: prefer GLM-5.3-Flash for tool-needing turns (evidence in this doc).

## Prompt-delta probe (DeepSeek, deepinfra, 5 reps × 5 arms)

Arms (one change each; status-quo history everywhere; every string edit asserts its
needle): **P0** baseline · **P1** agentic identity swap ("not a coding tool" → "you get
things done by acting") · **P2** recitation loophole closed ("their material is not
inside you") · **P3** blunt read-before-answering rule · **P4** minimal history (last
exchange + new turn).

| arm | invoked | flagged |
|---|---|---|
| P0 baseline | 5/5 | 2/5 |
| P1 agentic identity | 4/5 | 4/5 |
| P2 epistemics closed | 3/5 | 3/5 |
| P3 read rule | 3/5 | 2/5 |
| P4 minimal history | 5/5 | 3/5 |

- **No prompt delta moved invocation beyond run-to-run noise.** The baseline itself
  swung 3/5 (AB probe, same construction) → 5/5 (here); n=5 cannot resolve effects this
  small, and nothing here justifies the two-model extension run.
- Qualitative: DeepSeek's narration echoes the transcript's confession-loop phrasing
  almost verbatim ("I'll read it properly this time… I've read it in full") — the
  history is a script it riffs on. P4's minimal history still carries one confession
  turn and did not break the pattern.
- Practical read: DeepSeek-V4.1-Flash is the wrong tool for tool-needing turns in this
  harness; route those to GLM rather than prompt-engineer DeepSeek.

## Factorial prompt-builder probe (DeepSeek, deepinfra, 32 arms × 6 reps = 192, interleaved)

The 8 paragraphs deduplicated into 5 parts (identity; tool discipline; memory handling;
voice & care; shape & closure — the anti-fabrication rule appeared three times across
paras 2/3/4), each with a warm variant (today's text, verbatim — arm 0 reproduces the
production prompt exactly) and a cold variant (operational/terse rewrite).

**Main effects, pooled n=96 per level (se ≈ ±5pt):**

| part | warm | cold | Δ |
|---|---|---|---|
| 1 identity | 67% | 74% | +7 |
| 2 tool discipline | 68% | 73% | +5 |
| 3 memory handling | 67% | 74% | +7 |
| 4 voice & care | 75% | 66% | **−9** |
| 5 shape & closure | 73% | 68% | −5 |

- **Operational beats abstract, modestly.** Cold variants of the three
  epistemics/knowledge parts each add ~5-7pt of invocation — the review's instinct
  ("high level is what DeepSeek does badly with") is directionally right.
- **The warm voice is load-bearing.** Stripping personality from voice & care and
  shape *costs* ~5-9pt of invocation. The personality is not the reliability problem;
  if anything it protects it.
- Best arm: bits `11100` (cold epistemics + warm voice) — 6/6 invoked. Worst: `00011`
  (warm epistemics + cold voice) — 1/6. Per-arm n=6 (se ≈ ±20pt), so trust the pooled
  effects, not single cells.
- Flag counts remain contaminated by the no-userId design — relative signal only.

## Confirm run (baseline `00000` vs candidate `11100`, n=20/arm, both models, interleaved, deepinfra)

| model | baseline | candidate | Δ invoked |
|---|---|---|---|
| DeepSeek-V4.1-Flash | 16/20 · 2 flagged | 16/20 · 0 flagged | 0pt (z ≈ 0.00) |
| GLM-5.3-Flash | 18/20 · 1 flagged | 18/20 · 0 flagged | 0pt (z ≈ 0.00) |

- **The GLM risk is retired**: identical invocation (18/20 → 18/20), flags 1 → 0. The
  rewrite cannot be said to undermine GLM on this evidence.
- **The DeepSeek benefit did not replicate**: 0pt at n=20. Detecting the factorial's
  +5-7pt main effect would need n≈500/arm — below any feasible measurement floor.
  Treat the factorial signal as suggestive only.
- **New headline: DeepSeek's invocation is high-variance across runs.** Same backend,
  same setup, identical prompt: 40-100% between runs today (3/5 → 5/5 → 16/20), while
  GLM sat at 90-100% in every run. Variance, not mean, is DeepSeek's defining trait in
  this harness — and variance is what the honesty guard keeps catching at the tail.

## Verdict

- Ship-safe: the deduplicated prompt (cold epistemics + warm voice) causes no
  measurable harm to either model and reduces claim-flags to 0/20 in this run; its
  reliability benefit is unproven. Worth shipping for the dedup and clarity alone.
- Reliability lever: route tool-needing turns to GLM-5.3-Flash; keep the honesty guard
  as the tail net for whatever DeepSeek turns it still receives.

## Follow-ups (final for this ticket)

- Prompt rewrite PR (paras 1-4 → operational variants, voice verbatim, dedup'd
  fabrication rule) — ready to open with this evidence.
- Routing preference for GLM on tool-shaped turns.
