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
exports.purgeUserTraces = void 0;
const config_1 = require("../config");
/*
 * Best-effort LangSmith trace deletion (issue #143, factory reset scope).
 *
 * Every persisted chat turn is traced into the configured LangSmith project
 * with `metadata.session_id = <chat session id>` (set via withLangsmithMetadata
 * in mastraService, attached by routes/chat.ts since #224), so traces belonging
 * to a chat are deletable by that id. ZDR turns are not traced with a session
 * id (nothing durable exists to join):
 *
 *  - resolve the project's LangSmith id from its name (GET /api/v1/sessions)
 *  - query the run ids (POST /api/v1/runs/query, which returns
 *    `{ runs, ... }`, filter on metadata_key/metadata_value — the documented
 *    compliance pattern)
 *  - batch-delete the trace ids (POST /api/v1/runs/delete)
 *
 * Known limitations, all deliberate: the delete endpoint is asynchronous
 * (LangSmith returns 202 "queued" and does not confirm that any run matched,
 * so we cannot verify a deletion succeeded); it may be rate-limited or
 * disallowed by org policy; a run exported between our Mongo sweep and this
 * query can be missed. Consequently the whole service is failure-tolerant —
 * it logs and returns, never throwing, so a trace problem can never abort the
 * rest of the factory reset. Without an API key the exporter never ran
 * (mastraService gates on the same env), so the purge is a silent no-op —
 * dev/stub parity.
 */
const BASE_URL = 'https://api.smith.langchain.com';
const PAGE_SIZE = 100;
const MAX_PAGES = 100;
const DELETE_BATCH = 100;
const sessionMetadataFilter = (sessionId) => `and(in(metadata_key, ["session_id"]), eq(metadata_value, "${sessionId}"))`;
const purgeSessionTraces = (sessionId, headers, projectId) => __awaiter(void 0, void 0, void 0, function* () {
    const traceIds = new Set();
    let offset = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
        const queryRes = yield fetch(`${BASE_URL}/api/v1/runs/query`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                session: [projectId],
                filter: sessionMetadataFilter(sessionId),
                limit: PAGE_SIZE,
                offset,
            }),
        });
        if (!queryRes.ok) {
            throw new Error(`run query failed: HTTP ${queryRes.status}`);
        }
        // The endpoint answers an object (`{ runs, cursors, ... }`), not an array.
        // Keep the array guard as a shape assertion on `runs`: a missing or
        // malformed key must throw into the best-effort catch, not read as an
        // empty page.
        const body = (yield queryRes.json());
        const runs = body.runs;
        if (!Array.isArray(runs))
            throw new Error('unexpected run query response shape');
        for (const run of runs)
            if (run.trace_id)
                traceIds.add(run.trace_id);
        if (runs.length < PAGE_SIZE)
            break;
        offset += PAGE_SIZE;
    }
    const ids = [...traceIds];
    for (let i = 0; i < ids.length; i += DELETE_BATCH) {
        const deleteRes = yield fetch(`${BASE_URL}/api/v1/runs/delete`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                session_id: projectId,
                trace_ids: ids.slice(i, i + DELETE_BATCH),
            }),
        });
        if (!deleteRes.ok) {
            throw new Error(`run delete failed: HTTP ${deleteRes.status}`);
        }
    }
});
const purgeUserTraces = (sessionIds) => __awaiter(void 0, void 0, void 0, function* () {
    var _a;
    const apiKey = config_1.config.langsmith.apiKey;
    const project = config_1.config.langsmith.project;
    if (!apiKey || !project || sessionIds.length === 0)
        return;
    const headers = { 'x-api-key': apiKey, 'Content-Type': 'application/json' };
    try {
        const res = yield fetch(`${BASE_URL}/api/v1/sessions?name=${encodeURIComponent(project)}&limit=1`, { headers });
        if (!res.ok) {
            throw new Error(`project lookup failed: HTTP ${res.status}`);
        }
        const sessions = (yield res.json());
        // Name-match only: falling back to the first session returned would risk
        // issuing deletes against a project the config never named.
        const projectId = (_a = sessions.find((s) => s.name === project)) === null || _a === void 0 ? void 0 : _a.id;
        if (!projectId) {
            throw new Error(`project "${project}" not found`);
        }
        for (const sessionId of sessionIds) {
            try {
                yield purgeSessionTraces(sessionId, headers, projectId);
            }
            catch (err) {
                // One session failing (rate limit, HTTP error) must not give up on the
                // remaining ones — each session's traces are a separate best-effort
                // chunk, so continue and let the failure be logged.
                console.error('trace purge (best-effort) failed for a session:', String(err));
            }
        }
    }
    catch (err) {
        console.error('trace purge (best-effort) failed:', String(err));
    }
});
exports.purgeUserTraces = purgeUserTraces;
