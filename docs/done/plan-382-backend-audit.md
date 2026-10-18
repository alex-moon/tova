# #382 — Backend audit and criticism (in service of #387)

## Motivation

[#382](https://github.com/alex-moon/tova/issues/382): `apps/server/src/main` has grown
organically; build a list of follow-on work to clean it up and harden it. Additionally:
make TypeScript pass LSP diagnostics, and make every comment in every TypeScript file
abide by the AGENTS.md comment rule (single line, <80 chars).

Done with [#387](https://github.com/alex-moon/tova/issues/387) in mind: the roster
retirement is the aim, so the audit maps every roster/racing/TTFT/pricing touchpoint so
#387 can be planned directly from it.

## What was done

1. **Full read-only audit** of `apps/server/src/main` (all 137 files, six parallel passes
   by area: routes/middleware, connector layer, task/chat pipeline, workspace/memory
   stack, asset pipeline, evals/admin infra). Findings consolidated below and filed as
   GitHub issues.
2. **#387 touchpoint map** posted as a comment on #387: the exhaustive list of files,
   lines and decisions the roster retirement touches (chat routes, taskSequencer,
   admin model CRUD, traceStatsCost/sessionCostService price source, eval sweep
   universe, manageCommands, migrations, tests).
3. **LSP diagnostics**: `npm run typecheck` excludes test files, so 69 diagnostics in
   `apps/server/src/test/**` were invisible to CI. Fixed the errors and widened the
   check so tests typecheck too.
4. **Comment compliance**: mechanical scan over every tracked TS/TSX file
   (1,661 over-80-char comment lines across 316 files; 4 files with multi-line comment
   blocks). All violations rewritten to single-line, <80-char comments per AGENTS.md.

## Decisions

- **Audit output lives on GitHub, not in this doc.** Per repo rules, follow-on work was
  filed as issues; this doc records the audit method and links them.
- **#387 gets the full touchpoint map, not a summary.** The retirement is mostly a
  deletion exercise (rosterConfig, racingService, ModelRoster, admin CRUD); the two
  things that must be *built* are a replacement price source for cost estimates and a
  context-length source for the output-token budget. Both are called out on the ticket.
- **The lib bump for tests is `es2022` lib, not target.** `.at()` in tests needs the
  es2022 type definitions; bumping `target` would change emit for the build path, which
  is not wanted. Runtime (Node ≥20) already provides the APIs.

## Findings summary (details in the filed issues)

- **Duplication**: chat.ts streaming vs non-streaming handlers ~70% copy-paste;
  adminGuard ×4; aux-classifier wrapper ×5; zod error extraction ×15+; cursor pagination
  ×2; `extensionOf` ×3; `withTimeout` ×2; provider registries ×4.
- **Bugs**: `windowedHistory` drops the whole prompt when the newest message alone
  exceeds the cap; `TOVA_EVAL_PROVIDER` silently ignored; embedding title-fold parity
  breaks hash-skip (double embed spend); `numCandidates` no-op; factory-reset purge
  misses `workspace_embeddings`; `revocation_endpoint` SSRF; vacuous `ephemeral` guard
  in the asset worker; pre-race token budget/meta mismatch (dies with #387).
- **Hardening**: eval lease TOCTOU; task stale-requeue can double-run tasks; unescaped
  `task:completed`/`user:workspace` blocks in the system prompt (injection surface);
  unredacted ErrorLog persistence; missing deadlines on vector search/trace purge;
  asset pipeline stream/temp-file leaks; image decode bomb.
- **Dead surface**: `SYSTEM_PROMPT`, `RosterRoutingResult.filesLikely`, chat-scoped
  `WorkspaceStorage` methods, `ToolCallRecord.result`, the `typesafe` provider, the
  unenforced task cost budget, plus several un-exportable test-only exports.

## Done

- [x] Audit of all six areas, consolidated into GitHub issues (see Follow-ups).
- [x] #387 touchpoint map posted on the ticket.
- [x] LSP diagnostics: server tests typecheck; check widened in CI (`typecheck` covers
      tests via `tsconfig.lspcheck.json`; client and shared verified clean).
- [x] Comment rule compliance across every tracked TS/TSX file; scanner run reports
      zero violations.
- [x] `npm run ci` green.

## Follow-ups

Filed from the audit (each issue carries the file:line detail):

- #391 — chat route dedup + history-window/content bugs (feeds #387)
- #392 — prompt-envelope escaping (injection hardening)
- #393 — workspace-embedding correctness batch (parity, purge gap, ANN headroom)
- #394 — eval infra hardening batch
- #395 — task runtime hardening batch
- #396 — asset pipeline hardening batch
- #397 — server security / error-handling batch
- #398 — dedupe / dead-surface cleanup batch
- #387 — the roster retirement itself (the aim; carries the touchpoint map)
