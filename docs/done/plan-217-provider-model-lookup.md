# Plan — #217 Models admin: use provider API for details

Branch: `feat/tv/217-provider-model-lookup`
GitHub issue: alex-moon/tova#217

## Motivation

The owner wants to add a new model (e.g. `XiaomiMiMo/MiMo-V2.6-Flash`) to the
routing inventory without hand-researching cost and context window. DeepInfra
already publishes all of it on a public catalog endpoint keyed by the same
`DEEPINFRA_API_KEY` the connector uses. The admin Models tab should:

1. Offer a **Search** button next to the model input that calls a backend
   lookup and shows a summary of the key stats plus an **Add** button when the
   model is found ("Model not found" otherwise).
2. **Remove the manual stats form** — context/prices/capabilities all come from
   the lookup. The only remaining choice is the **tier** dropdown next to Add
   (subsequently removed too — see Groq investigation below).
3. Replace the per-row **Edit** button with a **Refresh** button that re-pulls
   the provider's current values and updates the row in place.

This also answers OQ-4 from the #199 plan ("manual entry now, catalog sync
deferred"): catalog sync lands here, scoped to DeepInfra.

## Groq investigation (owner request, 2026-10-04)

The owner asked to investigate Groq as a nice-to-have and, **if not
straightforward, remove the dropdown entirely (always DeepInfra)**.

Findings:

- `GET https://api.groq.com/openai/v1/models` **does** carry `context_length`
  and a `pricing` object — so a lookup is mechanically possible.
- But its prices are **USD per token**, not per 1M (`openai/gpt-oss-20b`:
  `prompt: '0.000000075'`), so it needs a ×1e6 conversion — an easy but real
  unit difference from DeepInfra, and a known order-of-magnitude hazard.
- More importantly, **Groq is not a completion provider by policy**: the
  ticket itself says "Groq is only ever used internally and is not registered
  as a provider in admin", and the routing code enforces it —
  `completionsPoolFor` pins `provider: 'deepinfra'` (#94), and `TIER_PROVIDER`
  maps only `guard` to Groq. A Groq row added through the admin "add a
  completion model" flow would be **inert** for completion routing.
- Groq is also absent from the completion seed set and used solely for the
  guard tier, which is env-managed (`ROUTER_GUARD_MODEL`).

Conclusion: Groq lookup is **not straightforward in a meaningful way** — it
would let an admin create a row that does nothing. Per the owner's fallback
instruction, the provider dropdown is removed: Add always uses DeepInfra. The
service keeps a `LookupProvider` union so a genuine Groq path can be added
later if the completion-pool policy changes.

## Verified API shape (2026-10-04)

`GET https://api.deepinfra.com/v1/openai/models?sort_by=openclaw&filter=with_meta`
with `Authorization: Bearer $DEEPINFRA_API_KEY`. Returns `{ object: 'list',
data: [...] }` where each entry is:

```json
{
  "id": "XiaomiMiMo/MiMo-V2.6-Flash",
  "object": "model",
  "metadata": {
    "description": "...",
    "context_length": 1048576,
    "max_tokens": 1048576,
    "pricing": { "input_tokens": 0.14, "output_tokens": 0.28, "cache_read_tokens": 0.0028 },
    "tags": ["chat", "vlm", "vision", "prompt_cache", "reasoning"]
  }
}
```

- `id` is the model name (matches `providerroutings.model`).
- `pricing.input_tokens` / `output_tokens` are already **USD per 1M tokens** —
  the repo's convention (verified against the #170 table: gpt-oss-120b
  $0.04/$0.17, Kimi-K2.6 $0.75/$3.5). No 1e6 scaling needed.
- `context_length` maps to `contextLength`.
- `tags` contains `vision` for multimodal models; `vlm` also appears.
- Non-chat entries (e.g. `tts`) have null `context_length` and character
  pricing — they must not resolve as chat models.

## Decisions

1. **One catalog fetch, filtered server-side.** The lookup service fetches the
   full list and finds `data[].id === model`. DeepInfra has no documented
   per-model metadata endpoint; the list is ~180 entries and cheap. Keep the
   call behind a small service so the admin route stays thin.
2. **Endpoint: `GET /api/admin/model-lookup?provider=deepinfra&model=<id>`**
   behind the existing `adminGuard`. Returns
   `{ found: true, provider, model, contextLength, inputPrice, outputPrice,
   vision, description }` or `{ found: false }`. The API key never reaches the
   browser.
3. **Price units are already per-1M; pass through unchanged.** This was flagged
   as the most likely order-of-magnitude bug in triage; the live probe confirms
   the endpoint already matches the repo convention.
4. **Reuse the existing model CRUD.** "Add" posts the lookup values through the
   current `POST /models` with the chosen tier. "Refresh" is `PUT /models/:id`
   with the re-fetched values. No new persistence path, no registry entity.
5. **Remove the manual stats form; keep `tier` as the only choice.** The form
   reduces to a Search button, a stat summary, and a small/large dropdown
   (plus `guard` for parity with existing rows — see OQ1). Tools/vision are
   defaulted from the lookup; the capability toggles in the table remain the
   way to correct them. **(Superseded by the Groq investigation: the provider
   dropdown is gone and Add always uses DeepInfra; the tier choice stays.)**
6. **Refresh is a silent overwrite of provider-owned fields** (contextLength,
   inputPrice, outputPrice) and vision if the provider reports it. The ticket
   says "updates the model automatically". It does **not** touch `tier`,
   `provider`, `model`, or `eligible`.
7. **A lookup miss is a normal response, not an error.** `{ found: false }`
   with HTTP 200; the UI shows "Model not found". A provider/network failure is
   a 502 with a message, so the UI can distinguish "we checked and it isn't
   there" from "we couldn't check".
8. **DeepInfra only.** The provider dropdown is removed entirely and Add always
   targets DeepInfra (see Groq investigation). The service is structured so a
   Groq resolver can be added later without changing the route contract.

## Done (checklist)

- [x] **T1 — Lookup service + config.** New
      `src/server/services/providerModelLookup.ts`: fetch DeepInfra catalog,
      normalize an entry to `{ contextLength, inputPrice, outputPrice, vision,
      description }`, return `null` on miss. Reads the key via the existing
      deepinfra connector env (`DEEPINFRA_API_KEY`). Unit tests with a mocked
      `fetch` covering: found, not found, missing/non-chat pricing, vision tag,
      HTTP error, network error.
- [x] **T2 — Admin route + contract.** `GET /api/admin/model-lookup` behind
      `adminGuard`, validating `provider` (`deepinfra`) and non-blank `model`.
      Response type added to `src/shared/contracts.ts`. Route tests: 401/403,
      validation, found/miss/failure, key-not-leaked.
- [x] **T3 — Client service + UI.** Add `lookupModel` to `AdminModelsService`
      and `AdminModelLookup` types. Rework the Models form: Search button,
      throbber, stat summary + Add, "Model not found" state, tier dropdown.
      Replace per-row Edit with Refresh. Client tests for the flow.
- [x] **T4 — Verify.** `npm run ci`, Playwright render of the Models tab at
      desktop and phone widths, full manual lookup against the live API for the
      ticket's `XiaomiMiMo/MiMo-V2.6-Flash` example.

## Ship (owner request, 2026-10-04)

When implementation and verification are complete, **commit, push the branch,
and open a PR** against `main` (do not wait to be asked again). The owner
explicitly requested this for this ticket.

## Verification (2026-10-04)

Automated:

- `providerModelLookup.test.ts` (8 cases) green: found, bearer key, miss,
  non-chat entry, no-vision tags, missing key, HTTP error, transport error.
- `admin.test.ts` route suite (4 new cases) green: 401/403, validation, found/
  miss 200s, 502 mapping with no key leakage.
- `AdminView.test.tsx` new cases green: search→summary→add with tier, miss,
  lookup error, refresh, refresh-miss-no-clobber; existing price/cool-off/
  cap tests retained. Full client suite 224 passing.
- Server lint/format/typecheck clean; client typecheck clean.

Live UI (Playwright, phone viewport via `playwright-cli open --mobile`),
against the local stack after `npm run stack:up` + `npm run db:password`:

- Logged in as the owner admin, opened `/admin` → Models. New form renders:
  Model input, disabled-until-text Search button, small/large Tier dropdown.
- **Found path:** searched the ticket's `XiaomiMiMo/MiMo-V2.6-Flash` — the live
  DeepInfra call returned Context `1,048,576`, In `$0.140`, Out `$0.280`,
  Capabilities `vision`, and an Add model button. The summary stacks cleanly at
  375px (`/tmp/opencode/admin-models-mobile.png`).
- **Refresh path:** set an existing row's context/prices to stale values
  (`1234` / `99` / `99`) directly in Mongo, clicked Refresh in the UI, and the
  row was updated in place to the live catalog values (`1,048,576` / `0.43` /
  `0.87`).
- **Miss path:** searched a nonexistent model → "Model not found", no Add
  button (`/tmp/opencode/admin-model-not-found-mobile.png`).

## Open questions

- **OQ1 (tier options).** The ticket says the dropdown is "small or large".
  Should `guard` remain selectable? DeepInfra is never a guard provider today
  (guard is Groq), so leaving it out is defensible, but existing rows can have
  any tier. Lean: show `small`/`large` only, since Add is for completion
  models and guard is env-managed.
- **OQ2 (partial data).** If the provider reports a model but no price (e.g. a
  chat model billed per character), admit with unknown price (repo convention,
  #199 OQ-3) or block? Lean: admit and show what we have; the over-cap logic
  already treats unknown as admitted.
- **OQ3 (Refresh on missing capabilities).** The lookup may not report `vision`
  reliably for every model. Lean: only set `vision: true` from tags, never
  force `false` on refresh, so an admin correction is not clobbered.

## Follow-ups (deferred)

- Groq model lookup: investigated and deliberately **not implemented** — Groq
  is not a completion provider by policy (#94 pins DeepInfra), so an admin-added
  Groq row would be inert, and its pricing is per-token, not per-1M. The
  provider dropdown was removed entirely as a result (owner instruction).
- #218 (Fireworks hot fallback) will want the same resolver generalised across
  providers and a `providers[]` model — out of scope here.
