# Branch audit (2026-09-16)

Sweep of all stale branches comparing each to `main`. Content equivalence was
checked at three levels: patch-id (`git cherry`), blob identity
(`git rev-parse branch:path` vs `main:path`, including archived docs under
`docs/done/`), and treediff of files only present on the branch.

## Deleted

| Branch                         | Ticket | Evidence                                                                                                                                           |
| ------------------------------ | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `feat/58-tools-asset`          | #58    | All commits patch-equivalent to work merged in PR #61                                                                                              |
| `feat/tv/34-asset-library`     | #34    | Plan doc blob identical to archived `docs/done/plan-34-asset-library.md`; `chat.ts` asset logic superseded by main's attachment path (PRs #47/#54) |
| `feat/tv/35-user-profiles`     | #35    | Treediff vs main is doc-only; plan doc identical to `docs/done/plan-35-user-profiles.md` (PR #46)                                                  |
| `feat/tv/41-ux-fixes`          | #41    | Treediff vs main is doc-only; plan doc identical to `docs/done/plan-41-ux-fixes.md` (PR #43)                                                       |
| `fix/tv/32-security-hardening` | #32    | PR #45 merged; branch tip contains unresolved `<<<<<<<`/`>>>>>>>` conflict markers (`validation.ts`, `auth.ts`) — nothing main lacks               |
| `feat/52-cheap-built-in`       | #52    | PR #56 merged; only branch-unique file (`mastraService.test.ts`) was deliberately deleted on main (`cb5adbd`)                                      |
| `feat/53-fix-theme`            | #53    | PR #60 merged; same deleted `mastraService.test.ts` is the only branch-unique file                                                                 |

## Kept

| Branch              | Ticket | Why                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `feat/49-bug-sweep` | #49    | PR #57 was **closed without merging**. Branch tip has content main lacks: `docs/spaces-cors.md` (67-line Spaces CORS runbook) and `e2e/assets.spec.ts` (155-line e2e attach-to-chat coverage). Note: it predates later main work, so it carries obsolete deletions of tests that now exist on main (`assetTools.test.ts`, `mastraRequestContext.test.ts`) and would need a rebase before any revive. |

## Incidental cleanup taken

- `/.iteration` added to main `.gitignore` (was carried on 7 of the 8 audited branches).

No follow-up tickets needed; the audit is a one-off.

# Branch cleanup (2026-09-18, issue #98)

Second pass over the branches orphaned after the 2026-09-18 merge wave
(#84–#97). Method: each branch's post-merge commits were cherry-picked onto a
fresh `feat/98-branch-cleanup` cut from current `main`; only commits that
survive as a real change are "content main lacks". `git cherry` alone is
unreliable here because the squash merges break patch-ids.

## Deleted

| Branch                         | Ticket | Evidence                                                                                                                                                    |
| ------------------------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `feat/66-allow-writing`        | #66    | Last commit (`f576cd6` critic, 09:52) predates squash `f1dbbc3` (10:13) — `diff squash..tip` is empty; every surviving hunk is stale pre-#82 code           |
| `feat/69-bulk-download`        | #69    | Last commit (`a86583a`, Sep 17 20:49) predates squash `dd4b6a` (20:57); `diff squash..tip` is empty                                                         |
| `feat/76-logging-view`         | #76    | Critic (`0c9689b`) + review fix (`feaa8bc`) predate squash `052a46a` (16:45); cherry-pick of the fix conflicts only with main's newer #91 AdminView rewrite |
| `feat/80-mcp-setup`            | #80    | 3-way merge-tree vs current `main` yields a zero diff — fully superseded                                                                                    |
| `feat/82-graceful-degradation` | #82    | Last commit is a merge commit into the squash (`25a46b4` 15:43 → squash `2e79e08` 15:50); critic commit only removes #66 tests that exist on main           |
| `feat/83-file-processing`      | #83    | Last commit (`b804a22` 16:28) predates squash `f75228fa` (16:43); 3-way merge-tree vs main yields a zero diff                                               |
| `feat/91-admin-view`           | #91    | Last commit (`1a103ed` 22:31) predates squash `fe9c52d` (22:50); content identical                                                                          |

## Preserved onto `feat/98-branch-cleanup`

| From                  | What                                                                                                                                                | Evidence                                                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `feat/77-mcp-errors`  | 63 lines of `mcpService.test.ts` hardening tests (critic `f27afe2`/`8cc60a9` postdate the 20:05 squash)                                             | 3-way merge-tree: clean, only these deltas vs main                                                                         |
| `feat/79-profile-tab` | `ScrollablePanel` shared component + `ProfileModal` refactor + tests (fix `f906287` postdates squash `2a36a6b`); shared panel is groundwork for #95 | Kept: ScrollablePanel.tsx/.test.tsx, ProfileModal.tsx; dropped: stale AdminView/McpServer test hunks superseded by #91/#97 |
| `feat/49-bug-sweep`   | `docs/spaces-cors.md` + `e2e/assets.spec.ts` (PR #57 closed unmerged; both still absent from main)                                                  | Only branch-unique files worth keeping per both audit passes                                                               |

`feat/96-start-from` is excluded from this pass — PR #99 is open against main.

Verification: `npm run ci` fully green on `feat/98-branch-cleanup`
(459 server tests, 128 client tests, both builds).

---

# Update (2026-09-20): post-squash residue sweep (issue #135)

After the 2026-09-16 audit, most of the `WIP:`/`feat:` first passes from tickets
#94–#129 had been squash-merged into `main`, while their continuation commits
(`test/hardening: critic pass`, `fix: address PR review comments`) stayed on the
orphaned branches. Issue #135 merged every remaining branch into current
`main` and confirmed with `git merge-tree` that each branch now merges with an
empty residual diff.

## Residuals landed with #135

- `feat/104-new-errors`: (superseded — `main`'s squash already contained the full pass).
- `feat/113-fetch-web`: safe-link scaffold kept via `feat/120-safe-link`'s version at merge time.
- `feat/117-no-content`: two pre-stream 429-detail tests surfaced in `chat.test.ts`.
- `feat/120-safe-link`: pool-flip test made order-independent in `modelConfigService.test.ts`.
- `feat/94-better-model`: `DEEPINFRA_API_KEY` documented in `.env.example`.
- `feat/135-orphaned-branches` (this PR): image-turn degradation tests, ZDR-hardened error paths,
  and output-token-cap multimodal tests kept over the `#115` squash.

## Deleted (now fully absorbed)

`feat/94-better-model`, `feat/95-profile-view`, `feat/96-start-from`,
`feat/98-branch-cleanup`, `feat/104-new-errors`, `feat/107-update-readme`,
`feat/109-no-mcp`, `feat/112-evals`, `feat/113-fetch-web`, `feat/114-0-results`,
`feat/115-image-handling`, `feat/116-zdr-option`, `feat/117-no-content`,
`feat/118-ui-tweak`, `feat/120-safe-link`, `feat/127-sources-list`,
`feat/129-prompt-routing`, and the leftover scratch branches `merge-tree` /
`tmp-ci-merge`.

## Not taken

- `feat/94-better-model`'s phase-2 "remove the `guard` routing tier from the
  DB" (schema enum change + `20260919100000-remove-guard-groq-routings.ts`):
  current `main` still seeds and uses a DB guard row (`TIER_PROVIDER.guard`),
  and the admin Compare tab filters on `tier`, so removing the tier needs its
  own evidence-first routing ticket (see AGENTS.md "Model routing decisions").
