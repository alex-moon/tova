import 'dotenv/config';
import { config } from '../apps/server/src/main/config';

/* Read logs from Grafana Cloud with the admin logs view's credentials. */
// @see #179

const lokiBaseUrl = (url: string): string => url.replace(/\/loki\/api\/v1\/push\/?$/, '');

const parseSince = (value: string): number => {
  const m = /^(\d+)([smhd])$/.exec(value);
  if (!m) throw new Error(`Invalid --since "${value}" (expected e.g. 30m, 2h, 7d)`);
  const n = Number(m[1]);
  const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 's' | 'm' | 'h' | 'd'];
  return n * unit;
};

interface Args {
  query: string;
  sinceMs: number;
  limit: number;
  raw: boolean;
  json: boolean;
}

const parseArgs = (argv: string[]): Args => {
  const args: Args = {
    query: '{job="tova"}',
    sinceMs: 3_600_000,
    limit: 100,
    raw: false,
    json: false,
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--since') args.sinceMs = parseSince(argv[++i]);
    else if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--raw') args.raw = true;
    else if (a === '--json') args.json = true;
    else positional.push(a);
  }
  if (positional.length) args.query = positional.join(' ');
  return args;
};

interface LokiStream {
  stream?: Record<string, string>;
  values?: [string, string][];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const { url, username, password } = config.loki;
  if (!url || !username || !password) {
    console.error('LOKI_URL / LOKI_USERNAME / LOKI_PASSWORD are not set in .env');
    process.exit(1);
  }

  const base = lokiBaseUrl(url);
  const requestUrl = new URL(`${base}/loki/api/v1/query_range`);
  const end = Date.now();
  requestUrl.searchParams.set('query', args.query);
  requestUrl.searchParams.set('start', `${end - args.sinceMs}000000`);
  requestUrl.searchParams.set('end', `${end}000000`);
  requestUrl.searchParams.set('limit', String(args.limit));
  requestUrl.searchParams.set('direction', 'backward');

  const auth = Buffer.from(`${username}:${password}`).toString('base64');
  const res = await fetch(requestUrl, { headers: { Authorization: `Basic ${auth}` } });
  if (!res.ok) {
    console.error(`Loki query failed (${res.status}): ${await res.text()}`);
    process.exit(1);
  }

  const body = (await res.json()) as { data?: { result?: LokiStream[] } };

  if (args.json) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  const entries: { ts: string; line: string }[] = [];
  for (const stream of body.data?.result ?? []) {
    for (const [ns, line] of stream.values ?? []) {
      entries.push({
        ts: new Date(Number(BigInt(ns) / BigInt(1_000_000))).toISOString(),
        line,
      });
    }
  }
  entries.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));

  if (!entries.length) {
    console.error('No log lines matched.');
    return;
  }

  for (const e of entries) {
    console.log(args.raw ? e.line : `${e.ts}  ${e.line}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
