import { config } from '../config';
import type { AdminLogEntry } from '../../shared/contracts';

/*
 * #179 read half: query retained logs from Grafana Cloud (hosted Loki) for the
 * admin logs view. The ingest half (Alloy -> Loki) is separate; this module is
 * the query side only.
 *
 * `LOKI_URL` is the full push URL (as Grafana Cloud hands it out), e.g.
 * https://logs-prod-035.grafana.net/loki/api/v1/push. The query API lives on
 * the same host at /loki/api/v1/query_range, so we derive the base by stripping
 * the push suffix.
 *
 * The whole service is failure-tolerant: an unconfigured or unreachable Loki
 * yields an empty page (with `configured: false` / an `error` message) rather
 * than throwing, so the admin view degrades to "no retained logs" instead of a
 * 500.
 */

// Default look-back window; owner asked for "last 24 hours is fine".
export const DEFAULT_HOURS = 24;
// Upper bound on the window an admin can request (7 days) — keeps a single
// query from scanning the whole retention period.
export const MAX_HOURS = 168;
// Default/maximum lines returned per query.
export const DEFAULT_LIMIT = 200;
export const MAX_LIMIT = 500;

export interface RetainedLogsParams {
  level?: 'info' | 'warn' | 'error';
  q?: string;
  hours?: number;
  limit?: number;
}

export interface RetainedLogsResult {
  logs: AdminLogEntry[];
  configured: boolean;
  error?: string;
}

const isConfigured = (): boolean =>
  Boolean(config.loki.url && config.loki.username && config.loki.password);

// Strip the push suffix to reach the Loki base URL on the same host.
const lokiBaseUrl = (url: string): string => url.replace(/\/loki\/api\/v1\/push\/?$/, '');

interface LokiStream {
  stream?: Record<string, string>;
  values?: [string, string][];
}

interface LokiQueryResponse {
  status?: string;
  data?: { result?: LokiStream[] };
}

/*
 * Best-effort severity from the raw line. Container stdout does not carry our
 * structured level, and Grafana's `detected_level` is not populated for these
 * streams, so we classify from the Docker `stream` label (stderr) and common
 * level tokens in the text. This is intentionally rough — it is a log viewer,
 * not a structured-events store.
 */
export const classifyLevel = (msg: string, streamLabel?: string): AdminLogEntry['level'] => {
  if (/\b(error|fatal|panic|exception|failed|failure)\b/i.test(msg)) return 'error';
  if (/\b(warn|warning)\b/i.test(msg)) return 'warn';
  if (streamLabel === 'stderr') return 'error';
  return 'info';
};

const toEntries = (streams: LokiStream[]): AdminLogEntry[] => {
  const entries: AdminLogEntry[] = [];
  for (const s of streams) {
    const streamLabel = s.stream?.stream;
    for (const [ns, line] of s.values ?? []) {
      entries.push({
        id: ns,
        ts: new Date(Number(BigInt(ns) / BigInt(1_000_000))).toISOString(),
        level: classifyLevel(line, streamLabel),
        msg: line,
      });
    }
  }
  // Newest first. Loki returns backward-order already, but flattening across
  // streams needs an explicit sort to be safe.
  entries.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return entries;
};

export const queryRetainedLogs = async (
  params: RetainedLogsParams = {},
): Promise<RetainedLogsResult> => {
  if (!isConfigured()) {
    return { logs: [], configured: false };
  }

  const hours = Math.min(Math.max(params.hours ?? DEFAULT_HOURS, 1), MAX_HOURS);
  const limit = Math.min(Math.max(params.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const end = Date.now();
  const start = end - hours * 60 * 60 * 1000;

  const base = lokiBaseUrl(config.loki.url as string);
  const url = new URL(`${base}/loki/api/v1/query_range`);
  url.searchParams.set('query', '{job="tova"}');
  url.searchParams.set('start', `${start}000000`);
  url.searchParams.set('end', `${end}000000`);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('direction', 'backward');

  const auth = Buffer.from(`${config.loki.username}:${config.loki.password}`).toString('base64');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Basic ${auth}` },
      signal: controller.signal,
    });
    if (!res.ok) {
      return { logs: [], configured: true, error: `Loki query failed (${res.status})` };
    }
    const body = (await res.json()) as LokiQueryResponse;
    let logs = toEntries(body.data?.result ?? []);
    // Level + text filtering is applied here (not in LogQL): a LogQL line
    // filter would be case-sensitive/regex-heavy and the level is inferred,
    // not indexed.
    if (params.level) logs = logs.filter((l) => l.level === params.level);
    if (params.q) {
      const needle = params.q.toLowerCase();
      logs = logs.filter((l) => l.msg.toLowerCase().includes(needle));
    }
    return { logs: logs.slice(0, limit), configured: true };
  } catch (err) {
    const message =
      err instanceof Error && err.name === 'AbortError'
        ? 'Loki query timed out'
        : 'Loki unreachable';
    return { logs: [], configured: true, error: message };
  } finally {
    clearTimeout(timeout);
  }
};
