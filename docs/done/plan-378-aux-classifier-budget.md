# Plan: #378 Aux classifier budget starved by reasoning model

## Motivation

[#378](https://github.com/alex-moon/tova/issues/378): despite the honesty guard (#371), the
assistant kept narrating tool results it never executed (formsatz "Blog draft review request",
15:00–15:03). LangSmith shows the guard fired on every turn and never once produced a verdict —
empty or mid-JSON-truncated output — and the metrics classifier was equally blind
(`llmSkipReason: 'parse'` on all nine user turns).

## Diagnosis

- Aux model `openai/gpt-oss-20b` is a reasoning model: it spends the token budget on hidden
  chain-of-thought before emitting content. Budgets of 120 (guard) and 100 (metrics) leave
  nothing for the answer — intermittent starvation (live probe: sometimes a verdict fits, the
  traces show it usually did not that hour).
- The failure was invisible: an unparseable/empty verdict left the message unassessed with no
  log (#371 semantics); #374's structured output changed it to silently recording a fallback
  **clean** verdict — worse.

## Decisions

- **Budgets → 1024** on both classifier call sites. gpt-oss-20b has a 128k window; the cap is
  a safety bound, not a cost driver (we pay for tokens actually generated), so be generous.
  Title/subtitle stay at 512 (plain short strings, working fine).
- **Garbage verdicts are detected, warned, and left unassessed** — not scored clean: empty raw
  text or a `length` finishReason returns null with a single-line warn (no honesty write, no
  badge, no corrective note). Partial-verdict validation failures with real text still fall
  back per #374.
- Metrics parse-skips now warn too (skipReason stays 'parse' in the DB as designed).
- Model choice (a non-reasoning aux classifier) stays an owner decision, evidence-first.

## Done

- [x] Guard + classifier budgets 1024, rationale comments
- [x] Garbage-verdict detection (empty / length) → warn + unassessed, tests for both live shapes
- [x] Live probe of the real hallucinated reply → valid flagged verdict
- [x] `npm run ci` green
