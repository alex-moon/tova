# Tova Overview

## Product Intent

`Tova` is a chat application that aims to feel like an application-layer service for inference providers. The product should let authenticated users chat through a clean web interface while the backend chooses the most appropriate model for each request from eligible provider model pools.

## Core Outcomes

- Authenticated user accounts with secure session handling
- Persistent chat sessions and message history stored in MongoDB
- Intelligent backend routing that selects models based on prompt complexity
- A React frontend served through a unified local development experience

## Product Scope

### In Scope

- Account registration, login, logout, and protected chat access
- Session-based chat persistence and session history navigation
- Router logic that can combine heuristics with model-assisted classification
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
- Routing runs a fixed, owner-locked **model roster** (`modelroster` collection) with per-turn **hedged provider racing** (#232): the lowest-scoring eligible model by `TTFT × price penalty` is picked, then raced across both of its serverless providers (DeepInfra + Fireworks) with the first token winning and the loser aborted. On total failure the roster falls through to the next model.
- Model pricing: each roster model carries `inputPrice`/`outputPrice` (USD per 1M tokens; cached pricing deliberately not modelled). Price enters the weighted score as a linear penalty (`ROSTER_PRICE_PENALTY_K`) so it breaks near-ties between models without dominating measured latency.
- Tool-using turns end with a user-visible confirmation: if a turn executed at least one user-facing tool but produced no assistant text (e.g. the run ended on a tool call at the step cap), the server synthesizes a short sentence naming what completed — "Created `agi-final.md`." — and streams/persists it like model text. A real model answer is never altered.
- Per-message prompt metrics persisted as a `metrics` subdocument on each message: deterministic features (counts, buckets, code/stopword/question/imperative indicators, session indices) computed synchronously at save time, plus LLM-classified dimensions (`metrics.llm`: emotional, technical, abstract, sentiment, open-ended) for user messages, filled post-save fire-and-forget via an auxiliary tool-free model call. Keeps message routing decisions and prompt features in one document for later routing-correlation analysis.

### Frontend

- React client focused on a straightforward chat workflow
- Semantic, maintainable UI structure rather than utility-framework-heavy styling
- Local development flow that keeps frontend and backend easy to run together

## Long-Lived Constraints

- Keep model selection abstracted away from end users.
- Every log emission path passes shared redaction before output (`src/server/services/logRedaction.ts` governs console/admin-buffer output; `traceRedaction.ts` applies the same policy to LangSmith span payloads). Long-form prompt content never lands in stderr or the admin logs view. Note residual surfaces: traces are only sent when a dev LangSmith key is set, and very short personal fragments in error paths are not fully covered by the conservative heuristic.
- Preserve secure auth defaults such as HTTP-only cookie handling.
- Keep local and production runtime claims aligned with the actual repository tooling.
- Prefer small, reviewable implementation increments over broad speculative rewrites.

## File-Storage Boundary (#149)

- All Spaces (S3-compatible) object access goes through `src/server/services/workspaceStorage.ts`. Only `workspaceStorage.ts` and test files may import `storageService.ts` directly (enforced by ESLint `no-restricted-imports`).
- The storage-agnostic surface is `WorkspaceStorage` (put/get/getStream/delete/list, keyed by userId + chatId + filename); it is the landing zone for the future workspace feature and a possible local (IndexedDB/fs) backend.
- Chat-scoped key layout: `<userId>/chats/<chatId>/<filename>`. Asset keys keep their existing `<userId>/<assetId>/<filename>` layout, accessed via the explicit `RawKeyStorage` byKey subset (assets carry their key strings on documents and have no chatId); Spaces-only extras (presigns, config probe) live in `SpacesCapabilities`, not on the agnostic interface.

## Delivery Workflow Note

This file is the stable product-intent summary.

- `docs/plan.md` is the ordered backlog index for numbered work packets.
- `docs/progress.md` is the execution log and current queue snapshot.
- Detailed implementation work should be defined in `docs/plan-XXX-*.md` packets rather than expanded here.
