# Plan — Issue #104 (New errors / model admin CRUD)

Two user asks landed on the same ticket:

1. The "strange" Groq/context-length errors came from prompt/output budgets
   exceeding the routed model's context window. Already handled in earlier
   commits on this branch (`outputTokenCap.ts`, router context-length-aware
   fallbacks, chat.ts wiring).
2. Ticket comments (2026-09-19):
   - Replace `allam-2-7b` with `openai/gpt-oss-20b` in the **live** DB.
   - Add CRUD to the Models admin view.

## Work done this pass

- **Live DB update** (ops, no code): via `ssh ajmoon`, updated the guard-tier
  `providerroutings` row `_id 6aa56f059a0240cb4e815400` from `groq/allam-2-7b`
  to `groq/openai/gpt-oss-20b` (matches the `ROUTER_GUARD_MODEL` seed default).
- **Server** (`src/server/routes/admin.ts`): `GET /api/admin/models` now
  returns per-row `providerroutings` entries (id = Mongo _id, tier, eligible,
  tools, vision, contextLength, per-model feedback stats). New:
  `POST /models` (create), `PUT /models/:id` (edit/disable), `DELETE /models/:id`.
  All admin-guarded, whitelisted-field validation, 409 on
  `(provider, model, tier)` duplicates, 404 on unknown ids. `contextLength: null`
  is accepted on update as an explicit clear (undefined keys get dropped by
  mongoose update casting, #seedDocFrom note in modelConfigService).
- **Shared contract** (`src/shared/contracts.ts`): `AdminModel` reworked from
  the grouped read-only shape to the per-row CRUD shape.
- **Client** (`src/client/src/services/admin.ts`,
  `src/client/src/components/AdminView.tsx`): `AdminModelsService` gained
  `createModel`/`updateModel`/`deleteModel`; the Models tab has an inline
  add/edit form (provider, model, tier, context, tools, vision) and per-row
  eligibility toggle + Edit/Delete. Mutations refetch the authoritative list.
- **Tests**: row-shape GET assertions rewritten; CRUD endpoint tests
  (authorization parity, validation, duplicate 409, 404 paths) in
  `admin.test.ts`; interaction tests (disable/edit/add/delete) in
  `AdminView.test.tsx`.

## Verify

`npm run ci` is the gate.
