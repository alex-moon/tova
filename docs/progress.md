# Packet Progress Log

## Status (current)

There are no outstanding tasks or plans in this repository.

The packet-based backlog (packets 001–005) is fully delivered and closed. All future planning and tracking happens on GitHub: issues track open work, and the repo is `alex-moon/tova` on branch `main`.

- Runnable product state: local end-to-end workflow documented in the root `README.md` (MongoDB via `npm run stack`, migrations via `npm run migrate`, backend and frontend on the host).
- Quality gate: `npm run ci` — lint, format, typecheck, server tests, client lint/format/tests/build. Passing as of this entry (4 suites / 20 tests).
- Model routing contract: documented in the root `README.md` ("Model Routing Contract").

## Delivery History (summary)

1. **Plan 001 — Reconcile root tooling and doc status.** Aligned the documented workflow, root tooling, and runnable entry points.
2. **Plan 002 — Stabilize server runtime and dependencies.** Backend boots reliably; dependency set is complete and supported.
3. **Plan 003 — Make the unified dev workflow runnable.** Host processes + dockerized MongoDB (`npm run stack`), migrations seeded an email-based admin, `dev`/`dev:server`/`dev:client` and the command table were established.
4. **Plan 004 — Add streaming chat responses.** `POST /api/chat/stream` (SSE) with `meta`/`delta`/`done` events; the client renders replies progressively; persistence unchanged; streaming tests added.
5. **Plan 005 — Expand router evaluation and tests.** Router test suite grew from 3 to 12 tests covering every deterministic and classifier branch plus fallbacks; `POST /api/chat` gained a routing-metadata test (`routing: { model, reason }`, `modelName` persistence); the routing contract is documented in the root `README.md`.

A more detailed historical log of packets 003–005 with artifact lists is preserved in the git history of this file. The compact summary above is the canonical narrative.

## Pre-packetization Context

Before the packet system: backend auth and data-persistence foundations, the router service, the React chat UI and session flows, and partial Docker/local-development support existed.

## Pointing Forward

- Open work lives in GitHub issues; do not recreate a local queue.
- The local docs stay static: `docs/overview.md` for product intent, this file for status and history, and this repository's `README.md`/`AGENTS.md` for workflows and agent rules.
