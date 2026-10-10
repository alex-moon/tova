"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.queryRetainedLogs = exports.classifyLevel = exports.MAX_LIMIT = exports.DEFAULT_LIMIT = exports.MAX_HOURS = exports.DEFAULT_HOURS = void 0;
const config_1 = require("../config");
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
exports.DEFAULT_HOURS = 24;
// Upper bound on the window an admin can request (7 days) — keeps a single
// query from scanning the whole retention period.
exports.MAX_HOURS = 168;
// Default/maximum lines returned per query.
exports.DEFAULT_LIMIT = 200;
exports.MAX_LIMIT = 500;
const isConfigured = () => Boolean(config_1.config.loki.url && config_1.config.loki.username && config_1.config.loki.password);
// Strip the push suffix to reach the Loki base URL on the same host.
const lokiBaseUrl = (url) => url.replace(/\/loki\/api\/v1\/push\/?$/, '');
/*
 * Best-effort severity from the raw line. Container stdout does not carry our
 * structured level, and Grafana's `detected_level` is not populated for these
 * streams, so we classify from the Docker `stream` label (stderr) and common
 * level tokens in the text. This is intentionally rough — it is a log viewer,
 * not a structured-events store.
 */
const classifyLevel = (msg, streamLabel) => {
    if (/\b(error|fatal|panic|exception|failed|failure)\b/i.test(msg))
        return 'error';
    if (/\b(warn|warning)\b/i.test(msg))
        return 'warn';
    if (streamLabel === 'stderr')
        return 'error';
    return 'info';
};
exports.classifyLevel = classifyLevel;
const toEntries = (streams) => {
    var _a, _b;
    const entries = [];
    for (const s of streams) {
        const streamLabel = (_a = s.stream) === null || _a === void 0 ? void 0 : _a.stream;
        for (const [ns, line] of (_b = s.values) !== null && _b !== void 0 ? _b : []) {
            entries.push({
                id: ns,
                ts: new Date(Number(BigInt(ns) / BigInt(1000000))).toISOString(),
                level: (0, exports.classifyLevel)(line, streamLabel),
                msg: line,
            });
        }
    }
    // Newest first. Loki returns backward-order already, but flattening across
    // streams needs an explicit sort to be safe.
    entries.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
    return entries;
};
const queryRetainedLogs = (...args_1) => __awaiter(void 0, [...args_1], void 0, function* (params = {}) {
    var _a, _b, _c, _d;
    if (!isConfigured()) {
        return { logs: [], configured: false };
    }
    const hours = Math.min(Math.max((_a = params.hours) !== null && _a !== void 0 ? _a : exports.DEFAULT_HOURS, 1), exports.MAX_HOURS);
    const limit = Math.min(Math.max((_b = params.limit) !== null && _b !== void 0 ? _b : exports.DEFAULT_LIMIT, 1), exports.MAX_LIMIT);
    const end = Date.now();
    const start = end - hours * 60 * 60 * 1000;
    const base = lokiBaseUrl(config_1.config.loki.url);
    const url = new URL(`${base}/loki/api/v1/query_range`);
    url.searchParams.set('query', '{job="tova"}');
    url.searchParams.set('start', `${start}000000`);
    url.searchParams.set('end', `${end}000000`);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('direction', 'backward');
    const auth = Buffer.from(`${config_1.config.loki.username}:${config_1.config.loki.password}`).toString('base64');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
        const res = yield fetch(url, {
            headers: { Authorization: `Basic ${auth}` },
            signal: controller.signal,
        });
        if (!res.ok) {
            return { logs: [], configured: true, error: `Loki query failed (${res.status})` };
        }
        const body = (yield res.json());
        let logs = toEntries((_d = (_c = body.data) === null || _c === void 0 ? void 0 : _c.result) !== null && _d !== void 0 ? _d : []);
        // Level + text filtering is applied here (not in LogQL): a LogQL line
        // filter would be case-sensitive/regex-heavy and the level is inferred,
        // not indexed.
        if (params.level)
            logs = logs.filter((l) => l.level === params.level);
        if (params.q) {
            const needle = params.q.toLowerCase();
            logs = logs.filter((l) => l.msg.toLowerCase().includes(needle));
        }
        return { logs: logs.slice(0, limit), configured: true };
    }
    catch (err) {
        const message = err instanceof Error && err.name === 'AbortError'
            ? 'Loki query timed out'
            : 'Loki unreachable';
        return { logs: [], configured: true, error: message };
    }
    finally {
        clearTimeout(timeout);
    }
});
exports.queryRetainedLogs = queryRetainedLogs;
