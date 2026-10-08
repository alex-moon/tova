# Plan — #214 preliminary: guard `files` vote + library-index injection

Branch: `feat/tv/214-files-retrieval`

## Scope note

This is **preliminary work against #214, not its resolution.** #214 is a
decision/design ticket ("decide whether/how to reference an existing file for
the next turn"). This change is a retrieval-reliability experiment that
generates evidence for that decision; it does not pick the reference mechanism
and must not close #214. Whether the ticket is then resolved (retrieval good
enough → Approach D; still unreliable → a reference affordance) stays open.

## Motivation

Issue #214 (`Decide whether/how to reference an existing file for the next turn`)
asks how a user should point the next turn at an already-uploaded library file.
Its open question 1 is the real crux: *is retrieval actually unreliable, or is it
a trust perception?* The owner's data point — retrieval has failed on local, and
the owner always primes with "tell me what files I have" first, which typical
users will not do — says this is a **retrieval-reliability** problem, not a
missing UI gesture.

This plan takes the "quick win" route the ticket itself gestures at (Approach D,
improve retrieval) rather than an attach affordance (B/C). When a turn looks
file-related, the server guarantees the model *sees* the user's library before it
answers. It does not force a tool call.

Owner direction captured 2026-10-03:

1. A classifier is needed — file references are rare and usually to a specific
   file not already in context; a blanket prefilter is too blunt (owner: "the
   user is likely to be referring to a specific file that isn't already in the
   chat context very rarely").
2. The guard tests one question: *"Is the user likely to be referring to a
   specific file in their library?"*
3. Truncation/limit: no semantic search for now (out of scope). Call the
   `list_files` limit out honestly instead.
4. Fold the new vote into the **existing** guard JSON — no second classifier
   service, no second round-trip.
5. Inject the library index into the context and add prompt guidance that the
   user is likely looking for one of these. Do not require `list_files`.

## Decisions

- **D1 — extend the existing guard, not a new classifier.** The router already
  makes one tool-free guard call per text turn (`routerService.routeQuery`,
  `inferenceService.createToolFreeCompletion`). Add a fifth vote `files` to the
  same JSON object. Zero added latency/cost; no new service.

- **D2 — `files` is an AUX vote and never drives the tier.** Today
  `guardVerdictFromReply` treats any category whose value is not `"no"` as a
  tier signal (`some(...) !== 'no'`). If `files` joined that set, "tell me about
  my resume" would route large on the files vote alone. So split the constants:
  `VOTE_CATEGORIES = ['reasoning','code','emotional','creative']` keeps driving
  the tier; `AUX_CATEGORIES = ['files']` is parsed separately by a new
  `guardFilesVoteFromReply`. A turn with `files:"yes"` and four `"no"` still
  routes **small** — the library block rides to whichever tier won.

- **D3 — `RoutingResult` carries the vote back.** Add `filesLikely?: boolean`
  to `RoutingResult`. Set it from the parsed vote object on every parseable
  verdict path; on unparseable/error paths it is `false` (conservative — no
  speculative Mongo read). This is the channel from the router to `chat.ts`.

- **D4 — library index is the injection, not a forced tool call.** On
  `filesLikely`, `chat.ts` fetches the user's ready assets and assembles a
  bounded index block passed into `buildSystemContent`. It **suggests** the
  match; `list_files` remains advertised in `TOOL_INSTRUCTIONS` as the catch-all
  for turns the vote misses. Forcing `list_files` was rejected: `routeQuery`
  returns only `{model, provider, reason}` and has no channel to inject a
  per-turn instruction, tools are advisory to small models anyway, and forcing a
  round-trip is exactly the owner's manual workaround rather than a fix.

- **D5 — injection point is `buildSystemContent` (owner chose option a).** Add an
  optional `libraryBlock` parameter, rendered as a new envelope block beside the
  entity-graph block. Rationale: #198's single-system-message invariant means
  `chat.ts` passes exactly one leading `role:'system'` message; growing that one
  message is cleaner than appending a second leading system message and relying
  on the connector's collapse. `modelCompare` calls `buildSystemContent(null)`
  and is unaffected (default `undefined`).

- **D6 — `libraryBlockFor(userId)` mirrors `list_files` exactly (owner point 3).**
  `Asset.find({ userId, status: 'ready' }).sort({ _id: -1 }).limit(21)`: 20 rows
  returned, the 21st only sets a `more` flag. The block states the limit and the
  truncation honestly ("showing the 20 most recent; more exist"). No semantic
  search, no ranking — that is explicitly out of scope.

- **D7 — injection is a read; ZDR stays consistent.** The block is assembled from
  the user's own library, the same read-only enrichment the entity graph already
  performs on ZDR turns (`getEntityGraph` injection at `chat.ts:635`). ZDR
  persists nothing; the block is built per-turn and discarded. Applies to all
  three completion paths: ZDR/replay, persisted, streaming.

- **D8 — empty library is a no-op.** If the user has no ready assets, the block
  is empty and the prompt is byte-identical to today (same regression guard the
  entity-graph block uses). The vote still fires but costs nothing.

## Done

- [x] `routerService.ts`: add `files` to the classification prompt with the
      single question ("likely referring to a specific file in their library"),
      distinguishing it from `generate_file` and from general chat.
- [x] `routerService.ts`: split `VOTE_CATEGORIES` (tier) from `AUX_CATEGORIES`
      (files); add `guardFilesVoteFromReply` (missing key → false); keep `files`
      out of the tier gate.
- [x] `routerService.ts`: add `RoutingResult.filesLikely`, emitted only when
      true (non-file turns keep the pre-#214 shape exactly); absent on the
      classifier-error path.
- [x] `chat.ts`: `libraryBlockFor(userId)` (bounded Mongo read) + exported pure
      `fileLibraryIndex` in `promptAssembly.ts` (cap at 20, truncation notice),
      and thread `filesLikely` from routing into all three completion paths
      (ZDR/replay, persisted, streaming). Non-streaming and ZDR paths now
      assemble the system message inside the failover closure from a fresh
      message array so retries cannot accumulate.
- [x] `promptAssembly.ts`: optional `libraryBlock` param on
      `buildSystemContent`, rendered as `<user:file_library>` with guidance that
      the user likely refers to one of these and to `read_file` the match.
- [x] Tests: guard prompt contains `files`; 5-key parse; `files` never flips the
      tier (files:yes + four no → simple, `filesLikely` still true);
      `guardFilesVoteFromReply` mapping (incl. missing key → false);
      `fileLibraryIndex` cap/truncation/empty; `buildSystemContent` renders the
      block and stays unchanged when empty.
- [x] Guard spot-check (evidence-first, per AGENTS.md): live probe of the shipped
      `classifyPrompt` + parser against the production guard
      (`openai/gpt-oss-20b` on Groq), 8 sample prompts — **8/8 matched** the
      expected `files` vote, and the two files-yes conversational prompts
      (`what did the lease say about pets?`, `check the Q3 report`) still routed
      **simple**, confirming the files vote does not influence the tier.
- [x] Gate: `npm run ci` green (exit 0; 1034 tests passed).

## Follow-ups

- **#214 itself remains open.** This work supplies the evidence for its open
  question 1 (is retrieval unreliable, or a trust perception?). Resolving #214 —
  choosing Approach D or adding a reference affordance — is a separate decision.
- **Semantic file retrieval** (owner point 3): matching a vague reference ("the
  Q3 one") to a specific asset needs embeddings/ranking; out of scope here. The
  honest truncation note in the block is the interim answer.
- **Retrieval legibility** (#214 Approach D residual): surfacing *which* file the
  model read (source chip) remains a client-side trust improvement, not covered
  by this server-side change.
