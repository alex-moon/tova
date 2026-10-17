# Plan: #368 Mastra structured output for aux/judge generation

## Motivation

[#368](https://github.com/alex-moon/tova/issues/368): every aux call site asks a model for JSON
and hand-parses prose — brittle, with silent all-null fallbacks. Mastra 1.66 supports
first-class structured output (`generate` accepts `structuredOutput: { schema }`, returning a
validated typed object with `errorStrategy: 'fallback'` + `jsonPromptInjection: 'auto'`).

## Capability verification (first step, per the ticket)

Probed all three candidate models with both aux shapes (flags object, string array) via
`scripts/verify-structured-output.ts` — findings recorded on the ticket
([comment](https://github.com/alex-moon/tova/issues/368#issuecomment-6235087603)):
all three (`groq/openai/gpt-oss-20b`, `deepinfra/deepseek-ai/DeepSeek-V4.1-Flash`,
`fireworks-ai/accounts/fireworks/models/glm-5p3-flash`) return valid objects with
`jsonPromptInjection: 'auto'`, no fallback. Note: `usedFallbackValue` is `undefined` (not
`false`) when unused on Mastra 1.66 — skip-reason mapping uses a truthy check.

## Decisions

- **Plumbing**: `CompletionOptions` gains optional `structuredOutput`
  (`{ schema: z.ZodType<T>, fallbackValue: T, jsonPromptInjection?: boolean | 'auto',
  errorStrategy: 'fallback' }`); `NeutralCompletion` gains `object`/`usedFallbackValue`. The
  tool-free connector passes it into `agent.generate` and surfaces `result.object`. Typed via
  a connector overload so call sites get `object: T` without casts.
- **Call sites migrated**: `metricsService` (flags, `parseLlmFlags` deleted),
  `followupService` (suggestions array, `parseSuggestions` deleted; item sanitisation kept —
  model-supplied strings still trimmed/capped/deduped), `titleService`/`subtitleService`
  (`{title}`/`{subtitle}` schemas; quote-stripping parse deleted, trim/cap kept),
  `honestyGuardService` (#371's parse deleted — same aux pattern),
  `evals/memory/helpfulnessEval.ts` judge (`parseJudgeVerdict` deleted; verdict enum schema,
  fallback `{verdict: 'error'}` preserves the error-not-tie semantics).
- **Skip-reason semantics preserved**: `usedFallbackValue` → `llmSkipReason: 'parse'` in
  metrics; unassessed-on-fallback in the honesty guard; `[]` on fallback in followups;
  heuristic fallback title/subtitle unchanged.
- **Not applied** (per the ticket): main chat replies, tool provenance lines.
- **Prompt updates**: reply-format lines ("Reply with ONLY a JSON array", "one token: A, B or
  TIE") are dropped — schema injection owns the format now; instructions stay.
- **Secondary item** (`getFullOutput()` simplification of the main stream mapping): split to
  its own ticket — it touches the hot chat path and does not belong in a mechanical aux
  migration.

## Done

- [x] Capability probe on all three models, findings on the ticket
- [x] `llmTypes` + tool-free connector: `structuredOutput` passthrough
- [x] metricsService migration (+ skipReason mapping)
- [x] followupService migration
- [x] titleService / subtitleService migration
- [x] honestyGuardService migration
- [x] helpfulnessEval judge migration
- [x] Test mocks updated to the Mastra result shape; parser tests deleted
- [x] `npm run ci` green

## Follow-ups

- `elementStream`-based incremental followup streaming (needs a client API change) — not this
  ticket.
- `getFullOutput()` stream-mapping simplification — split ticket if pursued.
