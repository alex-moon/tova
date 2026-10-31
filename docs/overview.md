# Tova Overview

## Product Intent

`Tova` is a chat application that aims to feel like an application-layer service for inference providers. The product should let authenticated users chat through a clean web interface while the backend chooses the most appropriate model for each request from eligible provider model pools.

## Core Outcomes

- Authenticated user accounts with secure session handling
- Persistent chat sessions and message history stored in MongoDB
- Intelligent backend routing: a fixed model roster ranked by measured TTFT × price, hedged across providers per turn
- A React frontend served through a unified local development experience

## Product Scope

### In Scope

- Account registration, login, logout, and protected chat access
- Session-based chat persistence and session history navigation
- Router logic that picks the roster's lowest-scoring eligible model and hedges it across provider backends (tier-era heuristic/classifier routing is retired, #387)
- Production serving through the backend and a practical local developer workflow

### Out of Scope

- Multimodal input and file analysis in the first release
- Team collaboration features
- Locking any single provider in (routing already treats providers as interchangeable pool members)

## User Experience Summary

- Users should not need to choose a model manually for normal chat usage.
- Users should be able to leave and return to previous sessions.
- Developers should be able to run the product locally without stitching together an ad hoc workflow.

## Architecture Intent

### Backend

- Express-based API and app server
- MongoDB-backed persistence for users, sessions, and messages
- Routing is env-pinned per function (#387): `CHAT_MODEL` (default `zai-org/GLM-5.3-Flash`) serves chat and `TASK_MODEL` (default `deepseek-ai/DeepSeek-V4.1-Flash-1017`) serves task steps. Chat hedges across the chosen model's known provider backends (DeepInfra + Fireworks) with the first token winning and the loser aborted; an unknown model override rides DeepInfra alone. Tasks pin DeepInfra and run the lean task agent (`taskMode`); tool choice is not forced, so a text-only step settles the task done (#425).
- Model pricing: a static (model, provider) → USD/1M table in `modelDefaults.ts` feeds the cost estimates; unknown model ids estimate as null (cached pricing deliberately not modelled).
- Tool-using turns end with a user-visible confirmation: if a turn executed at least one user-facing tool but produced no assistant text (e.g. the run ended on a tool call at the step cap), the server synthesizes a short sentence naming what completed — "Created `agi-final.md`." — and streams/persists it like model text. A real model answer is never altered.
- Per-message prompt metrics persisted as a `metrics` subdocument on each message: deterministic features (counts, buckets, code/stopword/question/imperative indicators, session indices) computed synchronously at save time, plus LLM-classified dimensions (`metrics.llm`: emotional, technical, abstract, sentiment, open-ended) for user messages, filled post-save fire-and-forget via an auxiliary tool-free model call. Keeps message routing decisions and prompt features in one document for later routing-correlation analysis.
- Auxiliary LLM calls (chat title, chat subtitle, follow-up suggestions, prompt-metric classification, and the honesty guard) run on a single cheap fixed **aux model** (`AUX_MODEL`/`AUX_PROVIDER`, default `openai/gpt-oss-20b` on groq — the retired guard model), independent of the chat/task models (#238). The entity graph retired with #256.
- **Workspace memory retrieval** (#253/#310): the enrichment gate is retired — the workspace-memory block (past chats, file contents, task transcripts) is retrieved unconditionally on every text turn, ranked by BM25 + Atlas vector search with a cross-encoder rerank-and-cut stage (#305) as the relevance bar. File discovery lives with the `list_files` tool.

### Frontend

- React client focused on a straightforward chat workflow
- Semantic, maintainable UI structure rather than utility-framework-heavy styling
- Local development flow that keeps frontend and backend easy to run together

## Long-Lived Constraints

- Keep model selection abstracted away from end users.
- Every log emission path passes shared redaction before output (`apps/server/src/services/logRedaction.ts` governs console/admin-buffer output; `traceRedaction.ts` applies the same policy to LangSmith span payloads). Long-form prompt content never lands in stderr or the admin logs view. Note residual surfaces: traces are only sent when a dev LangSmith key is set, and very short personal fragments in error paths are not fully covered by the conservative heuristic.
- Preserve secure auth defaults such as HTTP-only cookie handling.
- Keep local and production runtime claims aligned with the actual repository tooling.
- Prefer small, reviewable implementation increments over broad speculative rewrites.

## File-Storage Boundary (#149)

- All Spaces (S3-compatible) object access goes through `apps/server/src/services/workspaceStorage.ts`. Only `workspaceStorage.ts` and test files may import `storageService.ts` directly (enforced by ESLint `no-restricted-imports`).
- The storage-agnostic surface is `WorkspaceStorage` (put/get/getStream/delete/list, keyed by userId + chatId + filename); it is the landing zone for the future workspace feature and a possible local (IndexedDB/fs) backend.
- Chat-scoped key layout: `<userId>/chats/<chatId>/<filename>`. Asset keys keep their existing `<userId>/<assetId>/<filename>` layout, accessed via the explicit `RawKeyStorage` byKey subset (assets carry their key strings on documents and have no chatId); Spaces-only extras (presigns, config probe) live in `SpacesCapabilities`, not on the agnostic interface.

## Delivery Workflow Note

This file is the stable product-intent summary.

- Open work is tracked on GitHub (`alex-moon/tova`): issues for tickets, PRs for changes; there is no local backlog index.
- `docs/progress.md` is the static execution log.
- In-flight work gets a `docs/plan-<ticket>-<summary>.md` packet, archived to `docs/done/` when ready for review; detailed implementation work should be defined there rather than expanded here.
