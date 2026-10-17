# Tool-use reliability: probes, prompt rewrite, and the model-level verdict (#384)

## Motivation

Models that are reliable tool users in OpenCode (same roster: GLM 5.3 Flash, DeepSeek
V4.1 Flash) narrate tool use instead of invoking it in Tova — the honesty guard (#371)
patrols the symptom. Initial hypothesis: replayed history shows prior tool use as prose
claims plus a system-added `[tools used: …]` line with no structured
`tool_calls`/`tool` messages, teaching narrate-over-invoke (the #360 imitation incident
is the same mechanism at output time).

All probes run against the real "Review blog draft" session (formsatz@gmail.com, the
#382 reconstruction) — the natural experiment where fabrication happened in the wild —
with a fresh read-back turn; invocation (real tool calls) and claim-shape (via
`classifyAssistantTurn`) are the metrics.

## Experiment 1 — tool-history A/B (`scripts/eval-tool-history-ab.ts`)

Arms: (A) today's provenance-line history, (B) structured `tool_calls`/`tool` messages
with full rehydrated results, (C) structured with 400-char truncated results.

| model | A | B | C |
|---|---|---|---|
| GLM-5.3-Flash | 5/5 invoked | 5/5 | 5/5 |
| DeepSeek-V4.1-Flash | 3/5 | 3/5 | 2/5 |

- **Refuted:** structured history does not fix narrate-over-invoke for either model.
- Full results in history actively backfire (B vs C): content visible in-transcript
  invites "reading it back" from the transcript instead of re-reading the file.
- Structured replay stays parked (YAGNI unless new evidence appears).

## Experiment 2 — prompt-delta, five single-change arms (`scripts/eval-prompt-delta.ts`)

P1 agentic identity · P2 recitation loophole closed · P3 blunt read-rule · P4 minimal
history, against P0 baseline. **No arm moved invocation beyond run-to-run noise** — the
baseline itself swung 3/5 → 5/5 between runs at n=5. Qualitative: DeepSeek's narration
echoes the confession-loop transcript almost verbatim; the history is a script it
riffs on.

## Experiment 3 — factorial prompt builder (`scripts/eval-prompt-builder.ts`)

The 8-paragraph prompt deduplicated into 5 parts (the anti-fabrication rule appeared
three times), each warm (today's text) vs cold (operational); all 32 combinations,
interleaved, 6 reps each (192 completions). Main effects pooled n=96/level (se ≈ ±5pt):

| part | warm | cold | Δ |
|---|---|---|---|
| 1 identity | 67% | 74% | +7 |
| 2 tool discipline | 68% | 73% | +5 |
| 3 memory handling | 67% | 74% | +7 |
| 4 voice & care | 75% | 66% | **−9** |
| 5 shape & closure | 73% | 68% | −5 |

- Operational beats abstract, modestly — the knowledge paragraphs were too vague for
  DeepSeek.
- **The warm personality is load-bearing:** stripping it costs 5-9pt of invocation.
  The grounded-friend register is not the reliability problem; it protects reliability.
- Best combination: cold parts 1-3 + warm parts 4-5 (arm `11100`, 6/6).

## Experiment 4 — confirm run (baseline vs `11100`, n=20/arm, both models, interleaved)

| model | baseline | candidate | Δ invoked |
|---|---|---|---|
| DeepSeek-V4.1-Flash | 16/20 · 2 flagged | 16/20 · 0 flagged | 0pt (z ≈ 0.00) |
| GLM-5.3-Flash | 18/20 · 1 flagged | 18/20 · 0 flagged | 0pt (z ≈ 0.00) |

- The GLM risk is retired: the rewrite cannot be said to undermine GLM.
- The DeepSeek benefit did not replicate at n=20; detecting the factorial's +5-7pt
  would need ~500 reps/arm — below any feasible measurement floor.
- **DeepSeek's invocation is high-variance across runs** (40% → 100% → 80% today on
  identical setups) while GLM sat at 90-100% in every run. Variance, not mean, is
  DeepSeek's defining trait here — variance is what produces the fabrication tails the
  honesty guard keeps catching.

## Shipped in this PR

- **System prompt rewritten to the `11100` arm**: identity/tool-discipline/memory
  paragraphs are the operational cold variants (verbatim from the tested arm), voice
  paragraphs kept verbatim (load-bearing), and the anti-fabrication rule now stated
  once instead of three times. Pin tests updated.
- **Conscious trade-off:** the old "ask once, don't turn not-knowing into an intake
  interview" behaviour rode a replaced paragraph and is gone; the tested text shipped
  as-is.
- Probe scripts committed for reuse: `eval-tool-history-ab.ts`,
  `eval-prompt-delta.ts`, `eval-prompt-builder.ts` (their needle assertions target the
  pre-rewrite prompt — historical instruments, not rerunnable against it).

## Follow-ups

- Roster retirement ticket: replace the model roster/race with `CHAT_AI_MODEL` and
  `TASK_AI_MODEL` env vars (defaults GLM / DeepSeek), and explore DeepSeek for task
  work under GLM orchestration with a much simpler task prompt.
- Routing: GLM-5.3-Flash is the chat default; keep the honesty guard as the tail net.
