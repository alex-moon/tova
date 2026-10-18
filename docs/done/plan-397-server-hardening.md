# Plan — #397 server security / error-handling batch

From the #382 audit. Cross-cutting security and error-handling gaps in the server.

## Motivation

Audit ticket [#397](https://github.com/alex-moon/tova/issues/397). The headline item is an
SSRF where a malicious MCP authorization server can point `revocation_endpoint` at an
internal/`http://` URL and receive the user's bearer token during factory reset. The batch
also closes unredacted error persistence, a missing global error handler, and several
smaller hardening gaps.

## Decisions

- **Audit refs drifted** since the #382 audit; reconciled against current code:
  - Item 15 (`providerModelLookup.ts`) is **obsolete** — #387 retired the roster/lookup;
    the provider registry is static now. Nothing to do.
  - Item 11: the SafeBrowsingCache **TTL index already exists** (`checkedAt`, 24h). The
    remaining defect is hostname-keyed poisoning (one URL's verdict colors the whole
    host). Fixed by keying the cache on the full URL (schema field `host` → `url`).
  - Item 7's admin half (`admin.ts:323-327` returning `err.message`) no longer exists —
    admin routes use static messages today. Only the connectors handshake leak remains.
- **Item 12 (geo)**: rather than upgrading the ip-api fallback to https (impossible — its
  free tier is http-only), the plaintext fallback is **removed**. It sends the user's
  public IP in cleartext; country.is alone is the resolver now. The failure-cooldown map
  gains opportunistic pruning so entries cannot accumulate forever.
- **Item 13 (crypto)**: envelope-shape validation added at `decryptEnvelope` (iv 12 bytes,
  tag 16 bytes, non-empty ciphertext → clear error). The HKDF/key-rotation migration is
  deliberately deferred — it needs a re-encryption story for stored vaults and deserves
  its own ticket.
- **Item 14 (tracePurge)**: session ids are asserted to be 24-hex ObjectIds before they
  are interpolated into the LangSmith filter string (injection hardening), and all three
  fetches get `AbortSignal.timeout` so a hung LangSmith call cannot stall `purgeAllUserData`.
- **Item 17 (Loki)**: when level/q filters are present the page size is over-fetched
  (×4, capped at MAX_LIMIT) and sliced post-filter; the no-filter path is unchanged.
- **Item 16 (env casts)**: provider env accessors validate against the `LlmProvider`
  union and fall back to the documented default on a typo, instead of casting blindly.

## Done

- [x] 1. SSRF: `revocation_endpoint` validated with `assertPublicHttpsUrl` immediately
      before the revocation POST; invalid ⇒ skip (best-effort semantics unchanged).
- [x] 2. `persistErrorEntry` runs `redactString` before persisting ErrorLog rows.
- [x] 3. Terminal JSON error middleware in `createApp` (malformed JSON ⇒ 400, others ⇒ 500,
      details logged redacted, never sent).
- [x] 4. JSON 404 for unknown `/api/*` paths registered before the SPA fallback.
- [x] 5. Duplicate-email race: E11000 caught in `/register` (400) and in
      `resolveOrCreateUser` (re-find and return the winner).
- [x] 6. Google id_token `aud` checked against the configured client id.
- [x] 7. Connectors handshake failure returns a stable message; raw upstream error only
      in the (redacted) log.
- [x] 8. PAT `lastUsedAt` write throttled (in-process 5-min staleness map, bounded).
- [x] 9. `PORT=''` treated as unset (default 5000) instead of binding port 0.
- [x] 10. `adminEvals` GET handlers guarded with JSON 500s.
- [x] 11. SafeBrowsing cache keyed by full URL (schema `host` → `url`); tests updated.
- [x] 12. Geo: http ip-api fallback removed; failure-cooldown map pruned opportunistically.
- [x] 13. `decryptEnvelope` validates envelope shape with a clear error.
- [x] 14. tracePurge: timeouts on all fetches + session-id shape assertion.
- [x] 15. ~~providerModelLookup~~ obsolete (#387 removed the surface).
- [x] 16. Provider env accessors validated against the union at the accessor.
- [x] 17. Loki over-fetch when filters present; slice post-filter.
- [x] `npm run ci` green.

## Hardening round (pre-review break/harden pass)

Attack round on the draft found and fixed:

- **SSRF literal bypass in `assertPublicHttpsUrl`**: the name-regex missed
  `0.0.0.0` (connects to loopback on Linux) and IPv6 forms the URL parser
  canonicalizes (`[::ffff:7f00:1]` = v4-mapped loopback, `[fe80::1]`,
  `[fc00::1]`, `[::]`) — each could receive the bearer token despite item 1.
  Structured v4/v6 literal checks added behind the regex (which is kept for
  its name-shaped over-blocks); canonical integer/hex v4 was already safe.
- **Cache schema rename shipped without a migration**: prod rows keyed by
  `host` make the unique `url` index un-creatable (multiple `url: null`) and
  the stale unique `host_1` index E11000s every url-era upsert after the
  first. Migration `20261018120000-safelink-cache-per-url` drops the
  collection (24h-TTL cache, refills organically).
- **ErrorLog redaction ran after the 2000-char cut**: a secret straddling
  the boundary truncated into an unmatchable half-token. Redact first, then
  truncate.
- **Safe Browsing cache key kept credentials and fragment**: embedded
  `user:pass@` rode into stored rows and failure logs. Stripped pre-key.
- **adminEvals catches swallowed errors silently**: now logged redacted.

## Follow-ups

- HKDF + rotation path for `MCP_ENCRYPTION_KEY` (item 13 remainder) — candidate new issue.
- Hostname-based SSRF checks cannot stop DNS rebinding (attacker A record →
  loopback); complete fix is resolve-and-pin at connect time — candidate new issue.
