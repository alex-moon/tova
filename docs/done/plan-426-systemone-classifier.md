# Plan 426 — switch the prompt-dimension classifier to System One

## Motivation

[#426](https://github.com/alex-moon/tova/issues/426): DeepInfra (and Fireworks, behind an
account approval gate) now serves System One decision-model endpoints. Proposal posted on
the ticket: [comment](https://github.com/alex-moon/tova/issues/426#issuecomment-6819212236).
Verdict: migrate the prompt-dimension classifier only.

## Decisions

- **Scope: `classifyPromptDimensions` only.** Honesty guard keeps its LLM path (its `reason`
  field is free text a decision model cannot produce, and it is load-bearing — persisted and
  surfaced via the `honesty` SSE event). Malapropism judge (#424) is deferred corpus work;
  Fireworks is behind an approval gate — client stays provider-agnostic so it is a config
  change later.
- **Mapping.** `emotional`/`technical`/`abstract`/`openEnded` → `noul` questions, boolean
  from `noul >= 0.5`; `sentiment` → `choice` with criteria `{positive, negative, neutral}`.
  One request, five questions.
- **Resilience.** Decision call failure (missing key, non-2xx, malformed answers) falls back
  to the existing aux-LLM path, so `skipReason` semantics survive unchanged. A warn is logged
  on fallback with a constant format string.
- **Config.** New `decision` block in `config/index.ts`: `DECISION_MODEL`
  (default `Cloudflare/clef`), `DECISION_CLASSIFIER_ENABLED` (default on, `0`/`false` to
  disable) — same lazy-getter style as the rest of the config.
- **Live evidence (pre-implementation smoke test).** Two prompts run against
  `/v1/systemone` with the real question set: an emotional prompt read `emotional 0.97`,
  `technical 0.01`, `sentiment negative` (0.92 confidence); a technical prompt read
  `technical 0.87`, `sentiment neutral` (0.96 confidence). Response shape as documented,
  zero output tokens.

## Done

- [x] `systemOneClient.ts` — minimal fetch client for `/v1/systemone`
- [x] `config.decision` block with model + enabled pins
- [x] `classifyPromptDimensions` rides the decision path with LLM fallback
- [x] Tests updated: decision mapping, fallback behaviour
- [x] `npm run ci` green (123 suites / 1623 tests); Semgrep clean on touched files

## Follow-ups

- Revisit honesty guard migration once real classification data accumulates (its own ticket).
- Fireworks System One access when the account approval gate clears — config change only.
