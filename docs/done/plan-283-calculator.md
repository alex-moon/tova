# Plan — #283 Calculator tool (arithmetic)

Ticket: [alex-moon/tova#283](https://github.com/alex-moon/tova/issues/283).
Follow-up to [#263](https://github.com/alex-moon/tova/issues/263) (Epic: #251).

## Motivation

The #263 constitution originally listed **arithmetic** as weights-side. That premise is
wrong — LLMs get multi-digit products, percentages and multi-step sums wrong quietly — and
owner review caught it. #263 dropped arithmetic from the "trust yourself" list; this slice
adds the tool and points the prompt at it, so arithmetic becomes a tool case like
`current_datetime`.

## Decisions

- **`mathjs/number`, not full mathjs and not `@pmndrs/math`.** `mathjs/number` is the
  maintained number-only build (the deprecated `mathjs-expression-parser` package now
  redirects to it) and includes the expression parser — exactly "mathjs number-only".
  `@pmndrs/math` was considered and rejected: it is a graphics/geometry engine
  (vectors, quaternions, matrices, noise, IK) with **no expression parser or `evaluate()`**,
  so it cannot take an arithmetic string.
- **Locked down, because the expression is semi-untrusted.** The expression is
  model-generated, so a file the model reads or the user's message can steer it. mathjs's
  parser has a rough security history (prototype-pollution/RCE CVEs; a process-crashing
  range DoS). Three layers in `calculator.ts`:
  1. the documented `limitedEvaluate` lockdown — `import`, `createUnit`, `reviver`,
     `evaluate`, `parse`, `simplify`, `derivative`, `resolve` throw if reached;
  2. a strict character allowlist (`[0-9a-zA-Z +-*/%^().]`) — the range operator `:`
     (the DoS), array/object syntax, commas, quotes and assignment `=` are unreachable;
  3. a 200-char cap and a finite-number result check.
- **Always-on built-in, like `current_datetime`.** No API key and no per-user context, so
  the tool is attached unconditionally (unlike `web_search`, which is key-gated). Defined
  in `mastraService.ts` beside the other built-ins.
- **Version pinned `>=15.2.0`.** The prototype-pollution CVE (CVE-2026-40897 and friends)
  is fixed at 15.2.0; the installed version is 15.2.0 and `npm audit` reports nothing for
  mathjs.
- **Prompt: arithmetic moves to the tools side.** `SYSTEM_PROMPT` gains "Arithmetic is the
  same: work it through the calculator rather than trusting your head."; `TOOL_INSTRUCTIONS`
  names `calculate`; the #263 golden case is repointed at the tool.

## Done

- [x] `apps/server/package.json`: add `mathjs` (15.2.0).
- [x] `services/calculator.ts`: pure, never-throwing `evaluateExpression` with the
      three-layer lockdown.
- [x] `services/mastraService.ts`: `calculateTool`, registered in the agent tool map, plus
      a `TOOL_INSTRUCTIONS` line.
- [x] `promptAssembly.ts`: arithmetic added to the tools side.
- [x] `calculator.test.ts`: arithmetic/precedence/functions, the rejected inputs (range,
      arrays, quotes, assignment, over-long, non-finite), and the tool wiring.
- [x] `promptAssembly.test.ts`: pin the calculator line.
- [x] `evals/cases.ts` + `cases.test.ts`: rename `arithmetic-no-search` →
      `arithmetic-uses-calculator`; assert `calculate` is called and no reflex retrieval.
- [x] `npm run ci` green (97 suites, 1205 tests; client lint/format/test/build).
- [x] PR [#284](https://github.com/alex-moon/tova/pull/284) opened against
      `epic/251-workspace`.

## Verification

- `npm run ci` (server lint/format/typecheck/test incl. npm-audit/osv-scanner; client).
- Golden eval run: the arithmetic case passes via the tool (subject to provider
  availability and a `BRAVE_API_KEY` for the web cases).

## Follow-ups

- None opened. The `%` operator is mathjs modulus, not percent — the prompt/tool
  description steer the model to express percentages as multiplication (`0.18 * …`).

## Process log

- 2026-10-11 — slice opened on `feat/tv/283-calculator` (stacked on
  `feat/tv/263-workspace-prompt`, PR #282, so it builds on the corrected prompt):
  `mathjs/number` added, `calculator.ts` + lockdown,   `calculateTool` wired, prompt +
  `TOOL_INSTRUCTIONS` updated, the #263 golden case repointed at the tool, tests added.
  `npm run ci` green (97 suites, 1205 tests); `npm run audit` green (mathjs adds no
  advisories — the 28 reported are all pre-existing dev/tooling deps). Eval evidence on
  DeepSeek V4.1 Flash (DeepInfra): `arithmetic-uses-calculator` **pass** — the model called
  `calculate {"expression":"25 * 12 * 3"}` and answered 900.
