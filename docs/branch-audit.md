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
