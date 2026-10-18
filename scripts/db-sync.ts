import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { MongoClient, type IndexDescriptionInfo } from 'mongodb';
import { buildMongoUri } from '../apps/shared/src/main/mongoUri';

// Subcommands: dump, drop, restore, sync, password; destructive guarded.

// Fixture credentials: the PAT is below real token format, never app-mintable.
const TEST_PASSWORD = 'password';
const TEST_PAT = 'tova_pat_TEST';

const [, , cmd, ...args] = process.argv;
const FORCE = args.includes('--i-know-this-is-dangerous');
const DUMP_DIR = path.resolve(__dirname, '..', 'data/db-dumps');

const dumpUrl = () => {
  const url = process.env.MONGODB_DUMP_URL?.trim();
  if (!url) {
    console.error('Set MONGODB_DUMP_URL in .env to the source connection URI.');
    process.exit(1);
  }
  return url;
};

const targetUrl = () => {
  const url = buildMongoUri();
  if (url.includes('localhost') || url.includes('127.0.0.1')) return url;
  if (!FORCE) {
    console.error(
      `MONGODB_URL does not point at localhost/127.0.0.1 — refusing the destructive step.\n` +
        `Re-run with --i-know-this-is-dangerous if you really mean it:\n` +
        `  npm run db:<drop|restore|sync|password> -- --i-know-this-is-dangerous`,
    );
    process.exit(1);
  }
  return url;
};

// Parse the db name from the URI's last path segment (default `tova`).
const targetDb = (url: string): string => {
  try {
    const parsed = new URL(url);
    const name = decodeURIComponent(parsed.pathname.replace(/^\/+|\/+$/g, ''));
    return name || 'tova';
  } catch {
    const base = url.split('?')[0].replace(/\/+$/, '');
    return base.split('/').pop() || 'tova';
  }
};

const dump = () => {
  const url = dumpUrl();
  mkdirSync(DUMP_DIR, { recursive: true });
  const stamp = new Date()
    .toISOString()
    .replace(/[-:TZ]/g, '')
    .split('.')[0];
  const out = path.join(DUMP_DIR, `dump-${stamp}.tmp`);
  execFileSync('mongodump', ['--uri', url, '--out', out, '--quiet'], { stdio: 'inherit' });
  const dir = path.join(out, targetDb(url));
  if (!existsSync(dir)) {
    console.error(`mongodump produced no directory for db '${targetDb(url)}'`);
    process.exit(1);
  }
  const tarball = path.join(DUMP_DIR, `tova-tova-${stamp}.tar.gz`);
  execFileSync('tar', ['-czf', tarball, '-C', dir, '.']);
  execFileSync('rm', ['-rf', out]);
  console.log(`wrote ${tarball}`);
};

const drop = async () => {
  const url = targetUrl();
  const db = targetDb(url);
  const client = new MongoClient(url);
  try {
    await client.connect();
    await client.db(db).dropDatabase();
    console.log(`dropped ${db}`);
  } finally {
    await client.close();
  }
};

const latestTarball = (): string => {
  const wanted = args.find((a) => a.startsWith('--tarball'));
  if (wanted) return path.resolve(args[args.indexOf(wanted) + 1]);
  if (!existsSync(DUMP_DIR)) {
    console.error(`No ${DUMP_DIR} — run the dump first.`);
    process.exit(1);
  }
  const tarballs = readdirSync(DUMP_DIR)
    .filter((f) => f.endsWith('.tar.gz'))
    .sort()
    .reverse();
  if (!tarballs.length) {
    console.error('No *.tar.gz in data/db-dumps — run the dump first.');
    process.exit(1);
  }
  return path.join(DUMP_DIR, tarballs[0]);
};

const restore = () => {
  const url = targetUrl();
  const db = targetDb(url);
  const tarball = latestTarball();
  const workDir = tarball + '.restore-tmp';
  execFileSync('mkdir', ['-p', workDir]);
  try {
    execFileSync('tar', ['-xzf', tarball, '-C', workDir]);
    // Handle both tarball layouts: wrapped dumped-db dir or files directly.
    const entries = readdirSync(workDir);
    const dir =
      entries.length === 1 && existsSync(path.join(workDir, entries[0], targetDb(url)))
        ? path.join(workDir, entries[0])
        : workDir;
    execFileSync('mongorestore', ['--uri', url, '--db', db, '--drop', dir, '--quiet'], {
      stdio: 'inherit',
    });
  } finally {
    execFileSync('rm', ['-rf', workDir]);
  }
  console.log(`restored ${tarball} into ${db}`);
};

// Reset every credential to fixture values; guarded like drop/restore.
const resetPasswords = async () => {
  const url = targetUrl();
  const db = targetDb(url);
  const client = new MongoClient(url);
  try {
    await client.connect();
    const database = client.db(db);

    // bcrypt cost 10 must match the User model's pre-save hook.
    const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);
    const users = await database.collection('users').updateMany({}, { $set: { passwordHash } });

    // One shared tokenHash violates the unique index; drop it and warn.
    const pats = database.collection('pats');
    // No PATs = no `pats` collection; `indexes()` throws code 26 — ignore.
    let indexes: IndexDescriptionInfo[] = [];
    try {
      indexes = await pats.indexes();
    } catch (err) {
      if ((err as { code?: number }).code !== 26) throw err;
    }
    if (indexes.some((i) => i.name === 'tokenHash_1' && i.unique)) {
      await pats.dropIndex('tokenHash_1');
      console.warn(
        'warn: dropped unique index tokenHash_1 on pats so every PAT can share one digest — ' +
          're-create it (or restore a fresh dump) before trusting this database.',
      );
    }
    const patTokenHash = createHash('sha256').update(TEST_PAT).digest('hex');
    const patResult = await pats.updateMany({}, { $set: { tokenHash: patTokenHash } });

    console.log(
      `reset ${users.modifiedCount} user passwords to "${TEST_PASSWORD}" ` +
        `and ${patResult.modifiedCount} PATs to "${TEST_PAT}"`,
    );
    console.warn(
      `warn: "${TEST_PAT}" is a shared test credential, not a valid app-issued token — ` +
        'do not use it outside a local fixture database.',
    );
  } finally {
    await client.close();
  }
};

(async () => {
  switch (cmd) {
    case 'dump':
      dump();
      break;
    case 'drop':
      await drop();
      break;
    case 'restore':
      restore();
      break;
    case 'sync':
      dump();
      await drop();
      restore();
      break;
    case 'password':
      await resetPasswords();
      break;
    default:
      console.error(
        'Usage: npx tsx scripts/db-sync.ts <dump|drop|restore|sync|password> [--tarball <file>] [--i-know-this-is-dangerous]',
      );
      process.exit(1);
  }
})();
