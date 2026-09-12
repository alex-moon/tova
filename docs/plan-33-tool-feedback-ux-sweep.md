# Plan — #33 Tool use feedback and UX sweep

Branch: `feat/tv/33-tool-feedback-ux-sweep`

No open questions requiring the owner; all decisions in the issue are adopted. Any blocker will be raised as a comment on the ticket (running non-interactive).

## Server

1. **Neutral tool args** (`mastraService.ts` / `llmTypes.ts`): `NeutralStreamChunk.toolCall` gains `args?: Record<string, unknown>`; mapped from the Mastra `tool-call` chunk payload `input`/`args` fields (provider-agnostic).
2. **Stream route** (`routes/chat.ts` `/stream`): replace the single `status` hint with structured `tool` SSE events:
   - on `toolCall`: `{ name, label, args: { query } }` (label: `Searched the web`)
   - on `toolResult`: `{ name, status: 'ok', resultCount, domains }` (empty result → `status: 'empty'`); still collects `sources` and a `url→title` map.
3. **Per-source titles**: Message schema gains `sourceTitles: [{ url, title }]` when non-empty. The final `done` event carries `sourceTitles` alongside the saved message (which already has `sources`).
4. **Follow-up suggestions** (new `services/followupService.ts`): after the assistant message saves, generate 2–3 short follow-up questions with the guard model (`ROUTER_GUARD_MODEL`), reused `inferenceService.createCompletion` pattern as `titleService`. Skipped for trivially neutral prompts or empty content (`isTriviallyNeutral` reuse). Awaited briefly before the `done` event (bounded by the model call) so the stream delivers them; persisted as `suggestions: string[]` on the assistant Message. Generation failure ⇒ no field, no fatal.
5. **Admin models** (`routes/admin.ts` `GET /api/admin/models`, admin-only): `{ id(provider/model), provider, model, tiers[], stats: [{ band, up, down }] }` from `ProviderRouting` + `ModelMetricStat` grouping. Read-only.
6. Shared contracts extended in `shared/contracts.ts` where it mirrors client types.

## Client

- `Message` type: `sources?: string[]; sourceTitles?; suggestions?: string[]; tools?: ToolEvent[]`.
- `App.tsx`: parse `tool` events into the streaming message; on `done` merge sources/sourceTitles/suggestions.
- `ChatWindow.tsx`:
  - tool chip under the streaming assistant bubble (spinner → check/warn, query label, result count, collapsible detail);
  - Sources footer block (title links + `s2` favicons) when a message has sources/titles;
  - markdown `a` override: `target="_blank" rel="noopener noreferrer"`, external-link icon + link styling (post-sanitize);
  - follow-to-bottom auto-scroll while pinned, released when the user scrolls up;
  - follow-up chips after a completed turn fill the composer on click; static placeholder fallback for first load/failures.
- `AdminView.tsx`: read-only models table (band(s), up/down tallies).
- `index.css`: full `:root`/`.dark` token split so every `@theme` `--color-*` varies by theme.
- Toasts: `sonner` dep (per owner recommendation in (5)), `<Toaster />` in `App.tsx`, "Chat deleted" on success.
- New-tab links everywhere (`target=_blank rel=noopener noreferrer`).

## Tests

- Server: tool event payloads (call + result), sourceTitles on done, suggestions payload/persistence/skip, admin models endpoint.
- Client: tool chip states, sources block, external link target attributes, admin models table.
- Gate: `npm run ci`.

## Accepted trade-offs

- `s2` favicon service is a third-party call in the client (accepted in the issue; noted in PR).
- Suggestions are awaited before the final `done` event rather than a second event — keeps delivery in one event as specified; latency cost is one cheap guard-model call.
- `ModelMetricStat` has no request/latency tallies today (only up/down from #18); the admin table surfaces bands + feedback tallies now, metrics columns extend when stats land (#36 scope).
