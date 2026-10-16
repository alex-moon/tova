# Plan 356 — Agent-saved files: agent + owner visibility

Issue: https://github.com/alex-moon/tova/issues/356

## Motivation

`fetch_url` (#340) persists long pages as `system-side` assets (TTL 30 days) so
`read_file` can page through them. The 16 Oct chats for formsatz@gmail.com
exposed two discovery gaps:

1. In a later turn the agent called `list_files` to find the saved HN thread.
   `listFilesTool` deliberately excluded `origin: 'system-side'` (#340
   design: "the agent discovers it from the fetch_url result's fileId"), so in
   a new session the fileId was gone and the list came back without it. The
   agent concluded the save had silently failed and twice told the user it had
   lied — a trust failure caused purely by the discovery gap.
2. The owner could not see the saved page in the Files view either. The list
   API already supports `?origin=system-side` (#340), but the client has no
   filter affordance, so agent-facing files are unreachable in the UI.

Verified against the synced production dump: the asset row exists, `ready`,
318 KB, `expiresAt` exactly 30 days after creation — persistence and TTL are
fine; only discovery is broken.

## Decisions

- **`list_files` includes `system-side` rows by default** (no filter param on
  the tool). The #340 rationale ("discover via the fetch_url fileId") only
  works within the session that did the fetch; across sessions the agent was
  blind. Rows are flagged with a new optional `sourceUrl` field so the agent
  can match a cached page to a URL the user mentions and tell it apart from
  uploads. Tool description updated accordingly.
- **`read_file` untouched.** It already serves any owned `ready` asset,
  including `system-side` rows (no Spaces object needed — it reads the stored
  text).
- **Files view filter, no new API.** The server's `?origin=system-side`
  flip-the-filter behaviour (#340) is exactly the two-audience switch needed;
  the work is client-side: a segmented toggle in the AssetLibrary header —
  "My files" (uploads + generated, the default) vs "Agent files"
  (`system-side`).
- **Object-backed affordances hidden for agent files.** `system-side` rows
  have a synthetic key and no Spaces object, so the per-row "Get" download and
  bulk "Download selected" are hidden when agent files are involved; delete
  (row-only by design) stays. The upload dropzone is hidden in the Agent files
  view — an upload could never appear in that filtered list.
- **Attach picker unaffected.** ChatWindow's attach menu calls the list
  endpoint with no params; the server default keeps excluding `system-side`.
- **fetch_url note wording** tweaked to say where the copy lands (Files →
  Agent files) so the agent stops telling the user it is "in your library".

## Done

- [x] `listFilesTool`: drop the `origin: { $ne: 'system-side' }` exclusion;
      select + emit `sourceUrl` on listed files; description updated.
- [x] Server tests: the #340 "never lists agent-side rows" test flips to pin
      the new behaviour (listed, with `sourceUrl`).
- [x] Client `AssetSummary` gains `origin`; `AssetService.list` accepts an
      `origin` filter argument.
- [x] AssetLibrary: filter toggle (My files / Agent files), agent view hides
      upload dropzone + download affordances, empty-state copy for the agent
      view, per-row download guarded by `origin`.
- [x] fetch_url result note mentions Files → Agent files.
- [x] Client tests for the toggle (list called with origin, affordances
      hidden).
- [x] Playwright visual check at phone width (375px) on /files, both filters.
- [x] `npm run ci` green.

## Follow-ups

- If agent-saved pages ever crowd the 20-row `list_files` window, consider a
  tool-side filter param or a lower priority for `system-side` rows. Deferred
  until there is evidence of it.
