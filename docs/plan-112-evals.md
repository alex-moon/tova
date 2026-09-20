# Plan — #112 Deterministic evals

## Motivation

alex-moon/tova#112: Tova's differentiator is tool use, so the first eval investment should be
deterministic tool-use evals over a golden set, graded pass/partial/fail and shipped to LangSmith
so scores and traces can be tracked over time. GitHub and Bupa integrations must not be required —
what is evaluated is tool selection and sequencing, not the third-party service.

## Decisions

- **Graders are code, not LLM judges.** Each case declares assertions (tool called / not called /
  sequence / args subset / content equality / prompt containment) over an *observed run* shape
  (`EvalRun` in `src/server/evals/types.ts`), and `aggregateScore` maps them to pass (all hold),
  partial (some hold), fail (none). An empty run can never pass a tool assertion by construction.
- **Runs are observed from the neutral stream** (`NeutralChunkStream` from `mastraService`), which
  already exposes tool calls with scalar args and tool results tool-name-agnostically (#16). The
  runner records `(name, args)` + `(name, result)` pairs in order.
- **Temporary Mongo source**: a synthetic eval user seeded directly into the local `tova`
  database (`src/server/evals/mongoSource.ts`), not a separate database — the asset tools read
  through the shared Mongoose connection, so a dual connection risks pool conflicts for zero
  benefit. Seeding is idempotent (upsert by filename for the eval user) with a cleanup path.
- **Golden cases live in `src/server/evals/cases.ts`** as data, so both the runner and the
  LangSmith exporter can consume them. A `@repo:README.md` marker resolves the expected content
  from the repo at grading time (the real file is not inlined into the case).
- **LangSmith**: dataset + runs are pushed with the `langsmith` SDK only when
  `LANGSMITH_API_KEY` is set (transitive dep of `@mastra/langsmith`, already in the tree); without
  a key the runner still grades locally. Per-case feedback uses a raw 1 / 0.5 / 0 score with the
  assertion report as the comment, so the LangSmith UI shows partials, not just binary.
- **Run/grade is separate from the runner.** The grader is unit-tested offline; the runner needs
  `GROQ_API_KEY` and is explicitly not part of CI (same stance as `scripts/eval-classify-models.ts`).

## Cases

Started from the three in the ticket plus obvious built-in-tool siblings:

1. `github-readme-to-files` — copy README from alex-moon/tova: GitHub-ish tool call + `generate_file`
   with `filename=README.md` + content equality.
2. `bupa-fertility-files` — search files for a Bupa policy: `list_files` then `read_file`.
3. `pm-announcements-web` — recent UK policy news: `web_search` + current date grounding
   (`current_datetime` / prompt containing a date or location context).
4. `what-time-is-it` — time question must not web-search; `current_datetime` called.
5. `save-notes-file` — "save to my files" intent: `generate_file` only, no web search.

## Done

- [x] `EvalRun`/`Assertion`/`EvalResult` types + deterministic graders (`graders.ts`)
- [x] Grader unit tests (`graders.test.ts`)
- [x] `mongoUri` hardening commit (baseline)
- [x] Golden set cases (`cases.ts`) incl. the three ticket prompts + no-tool-negation extras
- [x] Temporary Mongo source (`mongoSource.ts`) with idempotent seed + cleanup
- [x] Runner (`scripts/run-evals.ts`) with optional LangSmith export
- [x] `npm run ci` green

## Follow-ups

- MCP tool-name matching for case 1 is a substring match (`*github*`); revisit if real MCP
  surface lands first (ticket note: exact-name assertion once a fixture MCP server exists).
- Coarse-location grounding for case 3 is asserted via prompt containment; a dedicated
  `prompt_contains_user_location` assertion can be added when location plumbing (#26) is in.
- Wire the runner into a nightly job once LangSmith scores baseline is agreed.
