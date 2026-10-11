# Plan — #251 Workspace-centric architecture (epic)

Umbrella issue: [alex-moon/tova#251](https://github.com/alex-moon/tova/issues/251).
This doc lives on `epic/251-workspace` and is always updated there. It is the **durable
state** for the whole epic — what the epic contains, what it has decided, and how far it
has got. It is *not* the loop's operating manual: the delivery loop's mechanics live in
`workspace.sh` at the repo root, and this doc must never describe or instruct the loop
that reads it.

The loop runs from `workspace.sh` on the owner's machine. What it needs from this doc is
only *state*: the invariants, the decisions, the Done checklist, and the open owner
questions. The loop reconciles that state against git and GitHub; it does not take its
instructions from here.

## Motivation

Per #251: Tova is a **workspace-centric personal agent**. The durable layer is the
workspace — *work products* (files, chat/task transcripts, digests) with **provenance**;
the provenance is the graph, and there is no concept extraction. Chats and tasks are
activities over the workspace (a chat's context is the conversation; a task's context is
the workspace). Memory is RAG over the map: a cheap gate deciding when to inject, a
bounded knowledge block into the system prompt, personal-scale retrieval. Incognito/ZDR
activity stays out of the map by contract. This supersedes #138's entity-graph design and
reconceives the closed #166 as the task entity.

Slices, in dependency order (#252 lands first as the prerequisite vocabulary; #256 is
subtractive and lands only after #253 proves out):

- #252 — workspace provenance on generated files (prerequisite vocabulary; tiny)
- #253 — workspace memory: retrieval across chats and files (flagship)
- #254 — task entity: offline agent sequencer over the workspace
- #255 — chat-task integration
- #256 — retire the entity graph

## Binding invariants (from #251; binding on all slices)

- **Single writer per stream.** Chat and task streams never write each other;
  cross-references are thin (origin ref, provenance, queued notification).
- **Incognito/ZDR sessions never become workspace items**; reading the map from a ZDR
  turn stays read-only.
- **No new infrastructure.** Mongo-only, in-process pollers, no brokers.
- **Evidence-first where behavior changes** — above all the #253 retrieval gate.

## Decisions (epic-level)

Slice-level decisions live in the slice plan docs; this section carries epic-level ones.

- **Loop mechanics are out of scope for this doc.** The four-phase fresh-context
  protocol that once lived here was removed when the loop moved into `workspace.sh`;
  keeping it in the doc caused the loop to edit its own instructions mid-run. The doc
  carries state only; `workspace.sh` carries the protocol. Owner decision, 2026-10-11.
- **Slice branches cut from `epic/251-workspace`**, slice PRs target the epic branch,
  never `main`; one epic PR to `main` at the end, linking this doc. Cross-merges between
  slice branches are allowed where one depends on another.
- **Owner-decision fallback:** where a slice ticket defers an owner decision (see
  below), the loop picks a conservative default, records it in the slice plan doc's
  Decisions, and flags it at the top of the slice PR for the owner to veto. The loop
  never silently blocks on an absent owner.

### Open owner questions (settle, or default-and-flag per the fallback)

- May the loop merge its own slice PRs into the epic branch on CI green (keeping the
  human gate at the epic→main PR), or does every slice PR wait for the owner? Unsettled:
  until answered, the loop opens PRs and waits.
- #253: injection budget (chars); whether the trivially-neutral skip gate already covers
  gate-firing; corpus retention (do old chats expire?); pass/fail thresholds for the
  gate evals (retrieval hit-rate, injection helpfulness, gate precision).
- #254: meter/pause/confirm behavior on budget breach.
- #256: entity-graph data disposition (keep read-only, archive, or drop).

## Done (epic)

- [x] Umbrella ticket #251 with slice tickets #252–#256, `epic` label, slices citing
      `Epic: #251`
- [x] Epic branch `epic/251-workspace` cut from `main`
- [x] Epic plan doc (this file)
- [x] Slice #252 — workspace provenance (PR #265 merged to `epic/251-workspace`; #252 closed)
- [ ] Slice #253 — workspace memory
- [ ] Slice #254 — task entity
- [ ] Slice #255 — chat-task integration
- [ ] Slice #256 — retire the entity graph
- [ ] Epic PR `epic/251-workspace` → `main`, linking this doc, `npm run ci` green
- [ ] Archive this doc to `docs/done/`

## Process log (epic-level tasks)

A dated, append-only record of what the loop did to the epic — one entry per meaningful
change, newest last. No phase numbers: the loop records outcomes, not protocol steps.

- 2026-10-10 — wrote this doc: epic plan, invariants, slice list, Done checklist.
- 2026-10-10 — owner correction: #252 is not done — PR #265 was preliminary. Done
  checklist, Decisions, and Follow-ups updated to match.
- 2026-10-11 — owner correction: the above was wrong. A follow-up check ran afterward
  and #252 is done — PR #265 is merged into `epic/251-workspace` and #252 is closed.
  Done checklist updated to match.
- 2026-10-11 — removed the four-phase operating protocol from this doc (it now lives in
  `workspace.sh`); doc rewritten as epic state only.

## Follow-ups

- Embeddings / vector search as a later #253 upgrade — only on eval evidence.
- ZDR task carve-out (#254) — later owner decision; default is no tasks for ZDR users.

