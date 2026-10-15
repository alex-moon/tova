# Plan — #332: PAT connectors — per-provider token setup instructions

## Motivation

Ticket: [#332](https://github.com/alex-moon/tova/issues/332) (Epic
[#328](https://github.com/alex-moon/tova/issues/328)). For providers without a
paste-free OAuth flow, the user must generate an API token themselves — and each
provider's "where do I click, which scopes do I tick" story differs. A bare token field
does not help a normal person.

## Decisions

- **Content as data in `@tova/shared`** (`apps/shared/src/connectorInstructions.ts`, new):
  a map from instruction id → ordered steps `{title?, body}` with an optional
  `scopeNote` (narrow-vs-broad scope guidance, saying what breaks if you go narrow).
  The catalog entry's `instructionsRef` keys into it; the connect modal renders steps
  in place of the generic fallback. One render path, provider content as data — no
  per-provider components.
- **Shipped content**:
  - **Atlassian** (the working token-mode connector today): id.atlassian.com → Security
    → API tokens → create; copy says the token grants access to whatever the account
    can see (products/sites the account belongs to) — Atlassian API tokens carry no
    per-scope ticks, so the guidance is about the account used, not scope selection.
  - **GitHub PAT fallback**: the catalog ships GitHub as OAuth (preferred); the modal
    notes the fallback exists for token-scoped access and the instructions cover a
    **fine-grained** PAT with narrow repository selection — explicitly saying what
    breaks when narrow (org repos not selected are invisible to the assistant).
- **Scope parity**: this slice changes client content only — token submission,
  encryption, never-echo, and the configured/unconfigured list semantics are already
  the #329/#327 behavior and stay untouched.

## Done

- [x] `connectorInstructions.ts` content + contract wiring (`instructionsRef` resolves)
- [x] Modal renders per-provider steps (Atlassian, GitHub fallback) with scope notes
- [x] Client tests: steps render for PAT entries; fallback copy still exists for
      entries without content
- [x] `npm run ci` green

## Follow-ups

- Community-server PAT entries (TMDB-style) join the catalog when curated (#330
  watchlist process); their instructions ride the same data path.
