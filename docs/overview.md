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
- Router service that decides whether a request should stay on a smaller model or escalate to a larger one
- Per-message prompt metrics persisted as a `metrics` subdocument on each message: deterministic features (counts, buckets, code/stopword/question/imperative indicators, session indices) computed synchronously at save time, plus LLM-classified dimensions (`metrics.llm`: emotional, technical, abstract, sentiment, open-ended) for user messages, filled post-save fire-and-forget via the guard-model path. Keeps message routing decisions and prompt features in one document for later routing-correlation analysis.

### Frontend

- React client focused on a straightforward chat workflow
- Semantic, maintainable UI structure rather than utility-framework-heavy styling
- Local development flow that keeps frontend and backend easy to run together

## Long-Lived Constraints

- Keep model selection abstracted away from end users.
- Preserve secure auth defaults such as HTTP-only cookie handling.
- Keep local and production runtime claims aligned with the actual repository tooling.
- Prefer small, reviewable implementation increments over broad speculative rewrites.

## Delivery Workflow Note

This file is the stable product-intent summary.

- `docs/plan.md` is the ordered backlog index for numbered work packets.
- `docs/progress.md` is the execution log and current queue snapshot.
- Detailed implementation work should be defined in `docs/plan-XXX-*.md` packets rather than expanded here.
