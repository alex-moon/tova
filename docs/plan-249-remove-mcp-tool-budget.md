# Plan #249 — Remove the MCP tool token budget

## Motivation

`mcpService.ts` carries a per-turn MCP "tool token budget" (default 1500 est.
tokens) that caps how many of a user's MCP tools attach to a chat request. It
originated in #77 as a mitigation for Groq's free-tier 8000 TPM limit and was
made provider-aware in #109 (skipped on `deepinfra`).

Since the roster migration the budget guards nothing real:

- `groq` is not a valid completion provider — it is only used internally for
  auxiliary/classification calls, all of which go through
  `createToolFreeCompletion` and never attach MCP toolsets.
- `typesafe` does not exist; its connector was never wired
  (`inferenceService.ts:18-23`), so resolution throws `Unknown LLM provider`.
- Chat completions are raced across the two roster providers (`deepinfra`,
  `fireworks`) via `racingService`; untagged turns should not exist.

The budget's only live teeth are the accidental audit of `fireworks` (budgeted
because it is "not deepinfra") and the `MCP_TOOL_BUDGET_TOKENS` operator
override. Both fence provider values that cannot legitimately occur on a
tool-attached path. Remove the functionality entirely. See issue #249.

## Decisions

- **Remove, do not disable.** No env flag, no dead branch kept "just in case".
  The rationale that justified the budget (#77's Groq 413) no longer applies on
  any reachable path.
- **Simplify `mcpToolsetsForUser` to `(userId?)`.** With no per-provider audit
  the `options.provider` parameter is meaningless. The cache key collapses back
  to the user id (the `|budget:<bool>` discriminator existed only to stop a Groq
  and a DeepInfra turn sharing a resolution, plan #109).
- **Drop `mcp.toolBudgetTokens` from config.** It is a raw env accessor with no
  other consumer; removing it removes the last `MCP_TOOL_BUDGET_TOKENS` surface.
- **Keep behaviour identical for platform toolsets.** They were always exempt
  from the budget, so nothing changes for them.
- **Out of scope (follow-up):** deleting the `typesafe` scaffolding and the
  untagged `groq` fallback in `inferenceService`. Those are adjacent dead code
  but a separate decision; flagged in Follow-ups.

## Done

- [x] `mcpService.ts`: delete `budgetAppliesFor`, `toolTokenBudget`,
      `estimateToolTokens`, `CHARS_PER_TOKEN`, the budget comment block, the
      `budgetApplies` branch + counters, and the drop `console.warn`. Also
      dropped the now-unused `LlmProvider` import.
- [x] `mcpService.ts`: `mcpToolsetsForUser(userId?)`; cache key = user id.
- [x] `mastraService.ts`: stop passing `{ provider }` at the `mcpToolsetsFrom`
      call site.
- [x] `config/index.ts`: remove `mcp.toolBudgetTokens` (and the `mcp` block).
- [x] `mcpService.test.ts`: remove the #77/#109 budget describe blocks.
- [x] `config/index.test.ts`: drop `MCP_TOOL_BUDGET_TOKENS` from `keys`, the
      set-value assertions, and the raw-accessor assertion.
- [x] Scrub `MCP_TOOL_BUDGET_TOKENS` from docs/env references (only the plan
      doc names it now; no `.env.example` entry existed).
- [x] `npm run ci` green (87 suites, 1065 tests).

## Follow-ups

- Remove the `typesafe` provider scaffolding (enum, `PROVIDER_SET` in
  `admin.ts`, `modelCompare` stubs) — confirmed dead end (#249 out of scope).
- Make the untagged-provider fallback in `inferenceService` an explicit error
  rather than a silent `groq` default, since untagged completions should not
  exist.

## Verification

- `npm run ci` (server lint/format/typecheck/test, client lint/format/test/build).
- No client surface; no e2e needed.
