# Plan: #143 — Purge becomes session-wide Factory reset (decouple purge from ZDR)

Status: in progress. Owner decisions resolved 2026-09-23 (triage on #143): #144's
decisions unblocked this ticket — per-chat incognito replaces per-user ZDR
(separate ticket), and the ZDR first-enable auto-purge is **removed**, not moved.

## Scope mapping

1. **Session-wide purge service** (done on this branch, commits 9d45e59/b4b4e0c):
   `services/userDataPurge.ts` → `purgeAllUserData(userId)` — hard-deletes
   sessions (soft-deleted included), messages, assets + Spaces bytes,
   chat-scoped workspace files (`deleteChatFiles` sweep added to
   workspaceStorage), `AssetJob` rows (via pre-fetched asset ids), the entity
   graph (`Entity`/`EntityEdge`), and fires the best-effort LangSmith trace
   purge (`services/tracePurge.ts`, tova-dev project, best-effort + failure
   tolerant). Returns `failedObjects` for bucket keys that could not be
   deleted. Coverage: `userDataPurge.test.ts`, `tracePurge.test.ts`.

2. **Product surface** (this ticket): `POST /api/profile/factory-reset`
   protected by a typed confirmation string (`RESET`, `FACTORY_RESET_CONFIRM`
   in validation.ts, enforced by zod `z.literal`); big red destructive button
   in ProfileView's new "Danger zone" fieldset, disabled until the input
   matches exactly, with a per-toast warning when any stored file deletions
   failed (server-reported `failedObjects`).

3. **Assets survive purge — re-decided**: under factory reset nothing
   survives; assets (docs, bytes, job rows) die with everything else. The
   "assets survive" shipped behaviour only ever applied to the old ZDR
   auto-purge, which is now gone.

4. **ZDR first-enable auto-purge**: REMOVED per the owner's 2026-09-21T16:44Z
   decision. `routes/profile.ts` no longer purges on a false→true zdr flip;
   `purgeUserChats` is deleted. The ZDR toggle is forward-looking only; the
   escape hatch for existing data is the explicitly confirmed factory reset.
   (Wiring ZDR/incognito end-state is #144's job.)

## Tests updated

- `routes/profile.purge.test.ts` rewritten: typed-confirmation guard (400s),
  unauthenticated guard, wipe-everything integration (PII-free assertions:
  zero sessions/messages/assets/entities/edges for the purging user, user B
  untouched, account + preferences survive), soft-deleted sessions die too,
  and a zdr-toggle-no-longer-purges regression test.
- `routes/profile.test.ts`: "first-enable auto-purge" describe rewritten as
  "zdr PATCH never purges as a side effect".
- Client: ProfileView factory-reset tests (disabled-until-exact-match, POST +
  success toast + reload, failed-objects warning, server-refusal error path).

## Open questions

- Does the account's zdr flag itself survive a reset? Decision: yes — it is a
  preference, not data (mirrors the userDataPurge.ts header comment). Once #144
  removes per-user ZDR entirely this becomes moot.
