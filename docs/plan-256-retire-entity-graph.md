# Plan — #256 Retire the entity graph

Slice of epic [#251](https://github.com/alex-moon/tova/issues/251). GitHub issue:
[alex-moon/tova#256](https://github.com/alex-moon/tova/issues/256).

## Motivation

#138's entity graph is superseded by the epic: the unit of memory is a *piece of work*
(a file, a transcript slice), not an extracted concept. Concept extraction is write-heavy
(one fire-and-forget LLM call per completed turn) and read-light (confidence-gated down to
a bounded block), and the epic replaces its *read* pattern with the #253 workspace-memory
retrieval. This slice is **subtractive**: it removes the extraction pipeline and the
injection wiring. No new behaviour.

## Binding design (from the epic)

- **No new infrastructure.** Mongo-only; a forwards-only migration drops the data.
- **Incognito/ZDR sessions never become workspace items.** Removing the entity graph does
  not change this — a ZDR turn already wrote nothing.
- **Evidence-first where behaviour changes.** This slice removes an unused path; it adds
  no behaviour to evaluate.

## Decisions

- **D1 — Remove the whole pipeline, not just the flags.** Delete
  `entityExtractionService.ts` (extraction + `ENTITY_GRAPH_ENABLED`),
  `entityRetrievalService.ts` (`retrieveKnowledgeBlock` + `ENTITY_GRAPH_PROMPT_INJECTION`),
  and the `config.entityGraph` accessors. The two `ENTITY_GRAPH_*` envs are removed from
  `.env.example` and `.env`.
- **D2 — Drop the data (owner decision, 2026-10-11, recorded in the epic doc).** The graph
  is unused, so nothing needs preserving. A forwards-only migration drops the `entities`
  and `entityedges` collections (mirroring `20261008130000-drop-provider-routing.ts`); the
  `Entity`/`EntityEdge` models and their `userDataPurge` references go with them. No
  archive, no read-only retention.
- **D3 — Remove the admin Graph tab.** #256 says repurpose it with the memory slice's
  control surface *or* remove it if that has not landed. The workspace-memory "what does
  Tova know" view has **not** landed, so the Graph tab, `AdminGraphService`, the
  `AdminGraph*` shared contract, and their tests are removed. The memory control surface is
  a follow-up (see Follow-ups).
- **D4 — `promptWords` moves to its only remaining consumer.** `workspaceRetrievalService`
  imported `promptWords` from `entityRetrievalService`; the helper (and its stopword set)
  moves into `workspaceRetrievalService` so the memory slice keeps working after the
  deletion. The `knowledgeBlock` parameter is removed from `buildSystemContent` entirely
  rather than left dead.
- **D5 — ZDR reads.** The ZDR branch's read-only entity block is removed with the rest.
  A ZDR turn still reads the workspace memory block read-only (#253), unchanged.

## Done

- [x] Slice branch `feat/tv/256-retire-entity-graph` cut from `epic/251-workspace`
- [x] Plan doc (this file)
- [x] Server: extraction service + test deleted
- [x] Server: retrieval service + test deleted; `promptWords` moved to
      `workspaceRetrievalService`
- [x] Server: `config.entityGraph`, `chat.ts` wiring, `promptAssembly` knowledge block
      removed
- [x] Server: admin graph routes + `Entity`/`EntityEdge` models removed
- [x] Migration drops the `entities`/`entityedges` collections
- [x] Client: admin Graph tab, service, and types removed
- [x] `userDataPurge` entity references removed; purge tests updated
- [x] `.env.example` / `.env` `ENTITY_GRAPH_*` removed
- [x] `npm run ci` green
- [ ] Slice PR opened against `epic/251-workspace`

## Follow-ups

- **Workspace-memory control surface** ("what does Tova know") — the read view #256 names as
  the Graph tab's replacement; not built here (the memory slice left it as a follow-up).
- **Memory gate evals** (#253 follow-up) — the evidence path before
  `WORKSPACE_MEMORY_ENABLED` turns on.
