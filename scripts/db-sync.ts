import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { MongoClient } from 'mongodb';
import { buildMongoUri } from '../src/server/mongoUri';

// One script, four subcommands:
//   dump    — mongodump MONGODB_DUMP_URL -> data/db-dumps tarball
//   drop    — drop the database in MONGODB_URL
//   restore — mongorestore --drop a tarball into MONGODB_URL
//   sync    — dump, drop, restore (the full migration round-trip)
//
// drop and restore are destructive against MONGODB_URL, so each refuses to
// run unless that URL points at localhost/127.0.0.1, or the caller appends
// --i-know-this-is-dangerous.

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
        `  npm run db:<drop|restore|sync> -- --i-know-this-is-dangerous`,
    );
    process.exit(1);
  }
  return url;
};

// MONGODB_URL carries its own db name; parse it out (default `tova`).
const targetDb = (url: string): string => {
  const base = url.split('?')[0].replace(/\/+$/, '');
  return base.split('/')[1] || 'tova';
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
    // Tarballs may contain a single dumped db directory (legacy db-dump.sh
    // layout) or the db files directly (dump above). Handle both.
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
    default:
      console.error(
        'Usage: npx tsx scripts/db-sync.ts <dump|drop|restore|sync> [--tarball <file>] [--i-know-this-is-dangerous]',
      );
      process.exit(1);
  }
})();
