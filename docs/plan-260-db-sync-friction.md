# Plan #260 — Make `db:sync` the unambiguous dump/restore surface for agents

## Motivation

Issue [alex-moon/tova#260](https://github.com/alex-moon/tova/issues/260): agents
instructed to pull a production dump into the local stack via `npm run db:sync`
instead go looking for `mongosh`, `mongodump`, and `mongorestore`, wasting time
and breaking the documented diagnostic workflow (sync production → interrogate
locally via `scripts/mongo.ts`).

## Diagnosis

The tooling itself works (verified end-to-end below). Three reinforcing causes,
all doc/artifact-level:

1. **Stale claim in AGENTS.md** — "There is no `mongosh` binary in this
   environment (yet)" was false: the full MongoDB toolchain (`mongosh` 2.10.0,
   Database Tools 100.18.0) is installed at `/usr/bin`. An agent that verifies
   the claim finds it wrong, stops trusting the section, and reverts to its
   prior that Mongo work means driving the raw binaries.
2. **Legacy duplicate scripts** — `scripts/db-dump.sh` / `scripts/db-restore.sh`
   (pre-#182, superseded by `scripts/db-sync.ts` in the #182 rescue) still sat
   in `scripts/` instructing readers to "Install MongoDB Database Tools",
   demanding env vars that don't exist in `.env` (`MONGODB_DUMP_URI` /
   `MONGODB_RESTORE_URI` vs the real `MONGODB_DUMP_URL`), and blocking on an
   interactive `read -p` prompt that hangs a non-interactive agent shell. Any
   agent globbing `scripts/*` for "how do I dump" found these first.
3. **Undocumented wrapping** — `db:dump` / `db:restore` / `db:sync` are thin
   wrappers that `execFileSync` `mongodump`/`mongorestore` (adding the localhost
   guard, tarball naming, and db-name parsing), but no doc said so. Reading the
   source re-anchored agents on the raw binaries instead of the npm scripts.

## Decisions

- **Delete the two legacy `.sh` scripts outright** (owner-confirmed). They are
  dead code — `package.json` routes every `db:*` script to `db-sync.ts` — and
  they are the only artifacts that actively point readers at installing or
  driving the binaries by hand.
- **Keep the legacy-tarball compat branch** in `db-sync.ts restore()`: old
  `db-dump.sh`-layout tarballs may still exist in `data/db-dumps/`. Only its
  comment is reworded (it referenced the deleted script as if it were live).
- **Docs state the wrapping relationship and name the anti-pattern**: the
  `npm run db:*` scripts are the only dump/restore surface, `scripts/mongo.ts`
  the only query surface; the Mongo binaries exist on PATH but are not the
  interface. A `db:*` script failing on a missing binary is an environment
  defect to report, not a cue to hand-roll commands.
- **No behaviour change to `db-sync.ts`**, and no pure-driver rewrite: the
  binaries are installed and the wrapper works; replacing `mongodump`/`mongorestore`
  with driver code would trade a working wrapper for BSON-export complexity the
  ticket does not ask for.

## Done

- [x] Delete `scripts/db-dump.sh` and `scripts/db-restore.sh`.
- [x] Reword the stale "legacy db-dump.sh" comment in `db-sync.ts restore()`.
- [x] AGENTS.md: replace the false no-`mongosh` claim with the installed-but-
      not-the-interface rule; add the never-invoke-the-binaries rule to the
      snapshots section.
- [x] README: note that the `db:*` scripts wrap the Database Tools.
- [x] progress.md entry.
- [x] Verify: `npm run db:sync` end-to-end + `scripts/mongo.ts` count + `npm run ci`.

## Follow-ups

- If agents still drift after this, the next suspect is `execFileSync`'s bare
  ENOENT when a binary is missing — a friendlier error inside `db-sync.ts`
  would point back at the npm-script surface. Not done now (the binaries are
  present; speculative).

## Verification

- `npm run db:sync` run for real (production dump → local drop → restore),
  then `npx tsx scripts/mongo.ts` counts against the local db — proves the
  documented frictionless path works.
- `npm run format` over the doc edits; `npm run ci` as the final gate.
