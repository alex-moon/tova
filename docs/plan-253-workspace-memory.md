# Plan — #253 Workspace memory: retrieval across chats and files

Epic: [#251](https://github.com/alex-moon/tova/issues/251). Slice ticket:
[alex-moon/tova#253](https://github.com/alex-moon/tova/issues/253).

## Motivation

A chat today sees the file-library index (gated by the #238 enrichment vote) and the
per-user entity block (#138). It cannot see any other chat. The epic supersedes the
entity graph: the unit of memory is a *piece of work* (a file, a transcript slice), not
an extracted concept. This slice is the flagship: "my chats can see each other", shipped
without the worker.

Memory is RAG over workspace items: a cheap gate, personal-scale retrieval, a bounded
knowledge block into the system prompt. The gate is the hard part — wrong injections
pollute every turn — so it must run on the same evidence path as routing changes
(§ Evals below), not intuition.

## Decisions

1. **Addressable views over existing collections — no eager copies.** The corpus is
   `Asset` rows (`textExtracted` / `markdownExtracted`) and `Message` rows joined to their
   `Session` for a title, read at retrieval time. Ticket: "thin records, content joined at
   retrieval time; no eager copies into library-shaped docs". Nothing new is written; the
   slice is read-only over what already exists (except the one gate refinement below).

2. **Gate = the #238 enrichment call, extended from "files?" to "workspace?".** Same
   single cheap aux call, same history-aware transcript, same bounded-serial posture
   (`ENRICHMENT_TIMEOUT_MS`, never throws). The prompt gains a second key `workspace` that
   fires when the request likely refers to *past work* — something from an earlier chat or
   a run — as opposed to the `files` key's "a library file to open now". The two keys are
   consumed separately: `files` still drives the library index, `workspace` drives the
   memory block. Keeping one call (rather than adding a second aux round-trip) preserves
   the #238 latency budget exactly.

3. **Gate refinement: the trivially-neutral skip already covers gate-firing.** The
   `isTriviallyNeutral` skip gate (`saveUserMessageWithMetrics`) short-circuits greetings,
   acknowledgements and other content-free turns *before* they reach the model, and the
   enrichment pass is only reached on a non-trivial turn. So no *additional* skip is
   needed for the memory block: a turn that would never be worth retrieving for is
   already excluded upstream. This is the ticket's open question ("whether the trivially-
   neutral skip gate already covers gate-firing") — answered yes, default recorded per the
   epic's owner-decision fallback, flagged at the slice PR for veto.

4. **Retrieval: in-process lexical scoring + recency, personal scale.** No vector DB, no
   Atlas Search in v1 (epic invariant "no new infrastructure"). Reuse the pure-scoring
   posture of `entityRetrievalService` (`promptWords` / a scored candidate pool): a recent
   bounded pool of message slices, keyword-overlap scoring, recency as a tiebreak only —
   an overlap of zero scores zero, so recency alone cannot drag irrelevant work into the
   block (same rule as the entity block). Embeddings remain a later upgrade, decided on
   eval evidence.

5. **Injection: a bounded `<user:workspace>` block, capped like `BLOCK_CAP`.** The
   surviving `retrieveKnowledgeBlock` shape: a short intro, then one line per retrieved
   slice (chat title + date + a truncated snippet), hard character cap, empty-on-nothing.
   Rendered by `buildSystemContent`, so both chat routes and the ZDR replay path assemble
   it identically and the empty block is a no-op (no prompt drift).

6. **Contract: ZDR/incognito turns are never corpus items; reading from a ZDR turn stays
   read-only.** The corpus is `Message`/`Session` reads; ZDR turns persist neither, so
   they are absent from the corpus by construction. A ZDR turn may still *read* the map
   (matching the entity block's plan-task-8 behavior) — read-only, no writes.

7. **Corpus retention: no expiry in v1.** Personal scale (a user's own message history)
   does not warrant a retention policy before there is evidence it hurts; bounding the
   candidate pool (decision 4) keeps cost flat regardless of history length. Flagged as a
   default for the owner (ticket open question), revisit on eval evidence.

8. **Task outputs are deferred.** The ticket lists "task outputs once the task-entity
   slice exists" in the corpus; #254 is not merged, so this slice retrieves chats and
   files only. When #254 lands, task artifacts join the same retrieval path (they are
   `Asset` rows with `provenance.kind: 'task'`, so decision 1 already admits them at the
   file level).

## Done

- [ ] Slice branch `feat/tv/253-workspace-memory` cut from `epic/251-workspace`
- [ ] Plan doc (this file)
- [ ] `enrichmentService`: `workspace` vote key + `workspaceVoteFromReply`, one call
      returns both votes
- [ ] `workspaceRetrievalService`: pure scoring + Mongo-backed bounded block
- [ ] `promptAssembly`: `<user:workspace>` block + `buildSystemContent` slot
- [ ] Both chat routes inject the memory block (persisted turns; read-only on ZDR)
- [ ] Tests: vote parser, scoring, block cap, retrieval, prompt assembly, route wiring
- [ ] `npm run ci` green
- [ ] PR opened against `epic/251-workspace`

## Owner decisions (defaults recorded per the epic fallback; flagged at the PR)

- **Injection budget (chars).** Default **1200 chars** for the memory block (below the
  entity block's 1500 because files already consume budget via the library index and the
  two blocks coexist). Tune from eval evidence.
- **Trivially-neutral skip covers gate-firing.** Yes — see decision 3.
- **Corpus retention.** No expiry in v1 — see decision 7.
- **Gate eval thresholds** (retrieval hit-rate, injection helpfulness, gate precision).
  Not defined in this slice: the eval harness for memory is a follow-up; the gate ships
  behind `WORKSPACE_MEMORY_ENABLED` (default off until evaluated, mirroring how
  `ENTITY_GRAPH_PROMPT_INJECTION` is opt-in) so it cannot pollute turns before evidence
  exists. Flagged for the owner.

## Follow-ups

- **Gate evals** (retrieval hit-rate, injection helpfulness, gate precision) via
  `evalRunService`/LangSmith — the ticket names these as the evidence path; the eval
  cases and pass/fail thresholds are not built here.
- **Task artifacts in the corpus** once #254 lands (decision 8).
- **Embeddings / hybrid vector search** — later upgrade, only on eval evidence (epic
  follow-up).
- **"What does Tova know" control surface** — the admin per-user read view named in the
  ticket; not built here (the admin Graph tab is the embryonic version and is superseded
  by #256).

## Process log

- 2026-10-11 — slice opened: branch, this plan, and the design above (gate extension,
  in-process lexical retrieval, bounded block, ZDR contract, 1200-char default). Corpus
  and gate follow the ticket verbatim; task outputs and evals deferred.
- 2026-10-11 — post-merge review hardening. Three defects fixed against the code and
  ticket: (1) the message pool is now scoped *session-first* — the previous
  `Message.find({ role: 'user' })` scan was global, so a busier user's recent turns could
  fill the whole window and starve this user's own history (ownership now resolved by the
  user's sessions before the message read); (2) the just-saved current turn is excluded
  from the corpus by id, so a turn is never retrieved and injected back as its own "past
  work"; (3) the block cap now counts joining newlines, so the rendered block truly stays
  within `BLOCK_CAP` rather than exceeding it by up to n−1 separators. Added route-level
  coverage proving the streaming route injects the block end-to-end (the plan's "both
  routes inject" item was previously only service-level-tested), plus tests for the
  starvation and self-retrieval fixes. `npm run ci` green (89 suites, 1125 tests).
- 2026-10-11 — merge-integration hardening. The #253 branch was merged with
  `epic/251-workspace` (PR #271). Review of the integrated state found four issues:
  (1) the two routes had drifted on ZDR — the streaming route read the workspace while
  the non-streaming route injected nothing, contradicting decision 6's "a ZDR turn may
  still read"; the non-streaming path now computes and injects the same read-only block,
  so the routes agree again. (2) the streaming ZDR branch computed the library index and
  discarded it (the index is never injected on ZDR) — it now passes `skipFiles: true`,
  dropping a wasted Mongo read. (3) the snippet shown per slice was the *head* of the
  source, so a match deep in a long document (a lease's pets clause) was retrieved but
  the injected line did not contain it; `matchSnippet` now centres the window on the
  first matched keyword, bounded by the same cap. (4) route-level coverage was
  streaming-only; the non-streaming route and both ZDR routes now assert the block
  end-to-end. `npm run ci` green (93 suites, 1164 tests).
