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
var __asyncValues = (this && this.__asyncValues) || function (o) {
    if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
    var m = o[Symbol.asyncIterator], i;
    return m ? m.call(o) : (o = typeof __values === "function" ? __values(o) : o[Symbol.iterator](), i = {}, verb("next"), verb("throw"), verb("return"), i[Symbol.asyncIterator] = function () { return this; }, i);
    function verb(n) { i[n] = o[n] && function (v) { return new Promise(function (resolve, reject) { v = o[n](v), settle(resolve, reject, v.done, v.value); }); }; }
    function settle(resolve, reject, d, v) { Promise.resolve(v).then(function(v) { resolve({ value: v, done: d }); }, reject); }
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.reconcileToolEvent = exports.streamingErrorMessage = exports.confirmationForToolResults = void 0;
const mongoose_1 = require("mongoose");
const express_1 = __importDefault(require("express"));
const auth_1 = require("../middleware/auth");
const Session_1 = require("../models/Session");
const Message_1 = require("../models/Message");
const User_1 = require("../models/User");
const Asset_1 = require("../models/Asset");
const attachmentEnvelope_1 = require("../services/attachmentEnvelope");
const assetLimits_1 = require("../services/assetLimits");
const workspaceStorage_1 = require("../services/workspaceStorage");
const racingService_1 = require("../services/racingService");
const titleService_1 = require("../services/titleService");
const userService_1 = require("../services/userService");
const promptAssembly_1 = require("../services/promptAssembly");
const entityRetrievalService_1 = require("../services/entityRetrievalService");
const geoLocationService_1 = require("../services/geoLocationService");
const outputTokenCap_1 = require("../services/outputTokenCap");
const metricsService_1 = require("../services/metricsService");
const promptMetrics_1 = require("../services/promptMetrics");
const followupService_1 = require("../services/followupService");
const entityExtractionService_1 = require("../services/entityExtractionService");
const validation_1 = require("../validation");
const logRedaction_1 = require("../services/logRedaction");
const zdrTurn_1 = require("../services/zdrTurn");
const modelConfigService_1 = require("../services/modelConfigService");
const enrichmentService_1 = require("../services/enrichmentService");
const router = express_1.default.Router();
const NO_ROUTING_PERMISSION = "You don't have permission to use the model router.";
// Asset attach (issue #34): resolves the attached asset for a turn — 'none'
// when the request sent no assetId, 'invalid' for a malformed reference,
// 'missing' when it points at a different user's asset.
// Turns that will actually carry pixels (#115). Mirrors buildImageTurn's
// conditions (image content type, uploaded-and-confirmed asset, configured
// storage) so routing and message assembly can never disagree: a turn that
// routed vision-only must never silently degrade to the filename envelope.
const turnsWithImage = (asset) => Boolean(asset &&
    asset.status === 'ready' &&
    (0, assetLimits_1.isImageContentType)(asset.contentType) &&
    workspaceStorage_1.spacesWorkspaceStorage.isConfigured());
const loadAttachedAsset = (req) => __awaiter(void 0, void 0, void 0, function* () {
    var _a, _b;
    const assetIdRaw = (_a = req.body) === null || _a === void 0 ? void 0 : _a.assetId;
    if (assetIdRaw === undefined || assetIdRaw === null || assetIdRaw === '')
        return null;
    if (typeof assetIdRaw !== 'string' || !(0, mongoose_1.isValidObjectId)(assetIdRaw))
        return 'invalid';
    const asset = yield Asset_1.Asset.findOne({
        _id: assetIdRaw,
        userId: (_b = req.user) === null || _b === void 0 ? void 0 : _b.id,
    });
    return asset ? asset : 'missing';
});
// Attached file text goes in through the structured attachment envelope
// (services/attachmentEnvelope.ts): untrusted-data rule first, then the
// <user_content> block. Stored/persisted user message stays the raw user
// text so the UI and metrics are unaffected.
const appendAssetBlock = (messages, asset) => {
    var _a, _b;
    const last = messages[messages.length - 1];
    if (asset && (last === null || last === void 0 ? void 0 : last.role) === 'user') {
        last.content += (0, attachmentEnvelope_1.buildAttachmentEnvelope)({
            filename: asset.filename,
            contentType: asset.contentType,
            size: asset.size,
            // Issue #67: markdown conversion is the fallback source when no fast-
            // path extraction exists (txt/md/csv keep winning).
            textExtracted: (_b = (_a = asset.textExtracted) !== null && _a !== void 0 ? _a : asset.markdownExtracted) !== null && _b !== void 0 ? _b : null,
        });
    }
};
// Issue #115: image attachments become real content parts on the current
// user turn instead of the filename-only envelope. The image rides in as a
// presigned Spaces GET URL (same mechanism `GET /assets/:id/url` serves);
// the <user_content> envelope is deliberately skipped for images — its
// "text" is binary noise. Returns true when the pixels flow this turn.
// Without storage configured the pre-#115 degradation holds: envelope with
// `text_extracted="false"`, no image part, no vision routing.
const buildImageTurn = (messages, asset) => __awaiter(void 0, void 0, void 0, function* () {
    // `ready` matters: a pending upload has no object in Spaces yet, so the
    // presigned GET would 404 inside the model's fetch and fail the turn.
    if (!(0, assetLimits_1.isImageContentType)(asset.contentType) ||
        asset.status !== 'ready' ||
        !workspaceStorage_1.spacesWorkspaceStorage.isConfigured()) {
        return false;
    }
    const last = messages[messages.length - 1];
    if ((last === null || last === void 0 ? void 0 : last.role) !== 'user')
        return false;
    const url = yield workspaceStorage_1.spacesWorkspaceStorage.presignGetByKey(asset.key);
    last.content = [
        { type: 'text', text: typeof last.content === 'string' ? last.content : '' },
        { type: 'image_url', image_url: { url } },
    ];
    return true;
});
// Provenance extraction (issue #16): web_search tool results arrive as
// { results: { title, snippet, url }[] }; URLs are collected incrementally
// deduplicated across all tool runs of the turn. Malformed entries are
// skipped, never fatal — the search enriches the turn but must not fail it.
// Per-source page titles are captured alongside the URL (issue #33) so the
// client's sources block can label links with real titles.
const collectSourcesInto = (sourceList, toolResult, titles) => {
    const items = Array.isArray(toolResult === null || toolResult === void 0 ? void 0 : toolResult.results)
        ? toolResult.results
        : [];
    for (const item of items) {
        const entry = item;
        const url = entry === null || entry === void 0 ? void 0 : entry.url;
        if (typeof url === 'string' && url !== '' && !sourceList.includes(url)) {
            sourceList.push(url);
            if (titles && typeof (entry === null || entry === void 0 ? void 0 : entry.title) === 'string' && entry.title) {
                titles.set(url, entry.title);
            }
        }
    }
    return sourceList;
};
// Tool outcome summaries for the SSE 'tool' events (issue #33),
// provider-neutral: any tool name flows through; only the label for
// first-party `web_search` is hard-known here.
const toolLabelFrom = (name) => name === 'web_search'
    ? 'Searched the web'
    : name === 'fetch_url'
        ? 'Fetched the page'
        : name === 'list_files'
            ? 'Listed your files'
            : name === 'read_file'
                ? 'Read a file'
                : name === 'generate_file'
                    ? 'Created a file'
                    : name || 'Tool run';
/*
 * Tools that are internal bookkeeping, not user-facing "work". A turn whose
 * only tool was one of these must not synthesize a confirmation ("I checked
 * the time.") — see plan #195. A turn with these plus any real tool still
 * confirms, but only for the real tool.
 */
const NON_CONFIRMING_TOOLS = new Set(['current_datetime']);
// Completed-tool confirmation (issue #195): when a turn ran at least one
// user-facing tool but produced no assistant text — the Mastra-documented
// "run ends on a tool call" case, e.g. `maxSteps` exhausting on tool rounds —
// this derives a short natural-language sentence naming what happened. It is
// only ever consulted when the model's own text is empty/whitespace, so a real
// answer always wins byte-for-byte.
const confirmationForToolResults = (results) => {
    var _a;
    const phrases = [];
    for (const { name, result } of results) {
        if (NON_CONFIRMING_TOOLS.has(name))
            continue;
        let phrase;
        if (name === 'generate_file') {
            const filename = (_a = result === null || result === void 0 ? void 0 : result.file) === null || _a === void 0 ? void 0 : _a.filename;
            phrase =
                typeof filename === 'string' && filename !== ''
                    ? `Created ${filename}.`
                    : 'Created the file.';
        }
        else if (name === 'web_search') {
            phrase = 'Searched the web.';
        }
        else if (name === 'fetch_url') {
            phrase = 'Fetched the page.';
        }
        else if (name === 'list_files') {
            phrase = 'Listed your files.';
        }
        else if (name === 'read_file') {
            phrase = 'Read the file.';
        }
        else {
            phrase = 'Finished the task.';
        }
        if (!phrases.includes(phrase))
            phrases.push(phrase);
    }
    if (phrases.length === 0)
        return null;
    if (phrases.length <= 3)
        return phrases.join(' ');
    return `${phrases.slice(0, 3).join(' ')} And more.`;
};
exports.confirmationForToolResults = confirmationForToolResults;
const toolCallEvent = (call) => {
    var _a;
    return (Object.assign({ phase: 'call', name: call.name, label: toolLabelFrom(call.name) }, (typeof ((_a = call.args) === null || _a === void 0 ? void 0 : _a.query) === 'string' && call.args.query ? { query: call.args.query } : {})));
};
/*
 * Stream error surfacing (#77): the generic message hides whether the
 * failure is actionable. A 413 / "Request too large" from the provider is a
 * prompt-size problem — user-connected MCP toolsets (#77) are the most
 * likely cause — so the surfaced message says so instead of the blank
 * 'Error streaming from model'.
 */
const streamingErrorMessage = (err) => {
    const message = err instanceof Error ? err.message : '';
    const statusCode = err === null || err === void 0 ? void 0 : err.statusCode;
    // #168: when every model cooled off after failures, the message itself is
    // the end-user text — pass it through verbatim.
    if (err instanceof modelConfigService_1.AllModelsDisabledError)
        return message;
    if (statusCode === 413 || /Request too large/.test(message)) {
        return ('Request too large for this deployment’s current rate limit — connected MCP servers ' +
            'may have added many tools to the request. Try again shortly or remove MCP servers in settings.');
    }
    /*
     * #117: a 429 (or its Groq-style message body that Mastra rethrows without a
     * status code) is actionable — the suggestion is simply to retry — so it is
     * surfaced as such instead of the generic streaming message.
     */
    if (statusCode === 429 ||
        /rate[ _-]?limit/i.test(message) ||
        /(tokens per minute|requests per minute)/i.test(message) ||
        /\bTPM\b|\bRPM\b/.test(message)) {
        return 'Rate limited by the model provider — please retry in a moment.';
    }
    return 'Error streaming from model';
};
exports.streamingErrorMessage = streamingErrorMessage;
const domainsFrom = (urls) => {
    const hosts = new Set();
    for (const url of urls) {
        try {
            hosts.add(new URL(url).host);
        }
        catch (_a) {
            // malformed URL: skip silently
        }
    }
    return [...hosts].slice(0, 5);
};
// Result chip counts (#114): per-tool counting semantics instead of a
// universal "count every array" heuristic — the universal one produced
// misleading "0 results" on tools without a results list.
//   web_search: count of results, domains from URL-bearing entries.
//   list_files: count of matched files (empty files + error = degraded, no count).
//   anything else (user-connected MCP etc.): a meaningful count only when the
//   top-level result has exactly one array-valued field; otherwise no count
//   and status 'ok' — absence of a count is not absence of success.
const singleArrayFieldLength = (result) => {
    if (typeof result !== 'object' || result === null || Array.isArray(result))
        return null;
    const arrayFields = Object.values(result).filter((value) => Array.isArray(value));
    return arrayFields.length === 1 ? arrayFields[0].length : null;
};
/*
 * Reconcile a tool event onto the running per-turn list (#196, decision D1).
 * A result merges into the most recent still-unresolved call of the same
 * name, flipping it to 'result' and carrying the call's query forward. A
 * result with no matching open call (e.g. a second web_search result) is
 * appended as its own entry rather than dropped; once an entry has flipped
 * to 'result' it is no longer a merge target, so a like-named second result
 * becomes a standalone entry. Mutates and returns the list for convenience.
 */
const reconcileToolEvent = (list, ev) => {
    if (ev.phase === 'result') {
        for (let i = list.length - 1; i >= 0; i--) {
            const candidate = list[i];
            if (candidate.phase === 'call' && candidate.name === ev.name) {
                list[i] = Object.assign(Object.assign({}, ev), (candidate.query ? { query: candidate.query } : {}));
                return list;
            }
        }
    }
    list.push(ev);
    return list;
};
exports.reconcileToolEvent = reconcileToolEvent;
const toolResultEvent = (result) => {
    var _a, _b, _c, _d;
    const base = {
        phase: 'result',
        name: result.name,
        label: toolLabelFrom(result.name),
    };
    if (result.name === 'web_search' || result.name === 'fetch_url') {
        const items = Array.isArray((_a = result.result) === null || _a === void 0 ? void 0 : _a.results)
            ? result.result.results
            : [];
        const urls = items
            .map((item) => item === null || item === void 0 ? void 0 : item.url)
            .filter((url) => typeof url === 'string' && url !== '');
        const hasResults = Array.isArray((_b = result.result) === null || _b === void 0 ? void 0 : _b.results);
        return Object.assign(Object.assign(Object.assign(Object.assign({}, base), { status: urls.length > 0 ? 'ok' : 'empty' }), (hasResults ? { resultCount: items.length } : {})), (urls.length > 0 ? { domains: domainsFrom(urls) } : {}));
    }
    if (result.name === 'generate_file') {
        const payload = result.result;
        const filename = (_c = payload === null || payload === void 0 ? void 0 : payload.file) === null || _c === void 0 ? void 0 : _c.filename;
        if (payload && typeof payload.error === 'string') {
            return Object.assign(Object.assign({}, base), { status: 'empty' });
        }
        return Object.assign(Object.assign(Object.assign({}, base), { status: 'ok' }), (typeof filename === 'string' && filename !== '' ? { filename } : {}));
    }
    if (result.name === 'list_files') {
        const payload = result.result;
        const files = Array.isArray(payload === null || payload === void 0 ? void 0 : payload.files) ? payload === null || payload === void 0 ? void 0 : payload.files : null;
        if (payload && typeof payload.error === 'string' && (!files || files.length === 0)) {
            // Degraded: empty files + error → no count (issue #114 plan task 1).
            return Object.assign(Object.assign({}, base), { status: 'empty' });
        }
        const count = (_d = files === null || files === void 0 ? void 0 : files.length) !== null && _d !== void 0 ? _d : 0;
        return Object.assign(Object.assign({}, base), { status: count > 0 ? 'ok' : 'empty', resultCount: count });
    }
    const count = singleArrayFieldLength(result.result);
    return Object.assign(Object.assign(Object.assign({}, base), { status: 'ok' }), (count !== null ? { resultCount: count } : {}));
};
// Session indices count only prior messages (computed before .save()), so a
// session's first message gets index 0. Count-based indices are racy under
// concurrent turns in one session; accepted in the plan
// (docs/plan-17-prompt-metrics.md) since metrics are analytical.
const buildMessageMetrics = (sessionId, content) => __awaiter(void 0, void 0, void 0, function* () {
    const priorCount = yield Message_1.Message.countDocuments({ sessionId });
    return Object.assign(Object.assign({}, (0, promptMetrics_1.computeDeterministicMetrics)(content)), { sessionMessageIndex: priorCount });
});
const createSessionWithUser = (userId_1, content_1, ...args_1) => __awaiter(void 0, [userId_1, content_1, ...args_1], void 0, function* (userId, content, { incognito = false } = {}) {
    const title = yield (0, titleService_1.generateChatTitle)(content);
    return Session_1.Session.create({ userId, title, incognito });
});
/*
 * Zero-data retention (#116): with the account setting on, the chat routes
 * keep nothing — no Session row, no Message rows, no fire-and-forget
 * classification, no title generation. Continuity within an ephemeral chat is
 * the client's replay: a bounded, validated `history` array rides each turn
 * and is assembled below, mirroring what a persisted session's
 * `Message.find({ sessionId })` would return.
 */
const buildZdrMessages = (history, content) => [
    ...history,
    { role: 'user', content },
];
const messagesFromPersistedHistory = (history) => history.reverse().map((m) => ({
    role: m.role,
    content: m.content,
}));
/*
 * #238: the aux enrichment prompt wants plain text history, oldest first, and
 * WITHOUT the just-saved current turn (it rides separately as the query). The
 * persisted find is newest-first and includes the current turn, so it is
 * dropped by id and the tail reversed — the pre-#232 `guardHistoryFromDocs`
 * shape, non-mutating this time (the same `history` array is reused below).
 */
const enrichmentHistoryFromDocs = (docs, currentMessageId) => [...docs]
    .filter((m) => String(m._id) !== String(currentMessageId))
    .reverse()
    .map((m) => ({ role: m.role, content: m.content }));
// Throwaway chat attachments (#116): as soon as the turn that consumed them
// completes, the row and its Spaces object go. Never throws — cleanup must
// not turn a finished answer into an error.
const cleanupEphemeralAsset = (asset) => __awaiter(void 0, void 0, void 0, function* () {
    if (!asset || asset === 'invalid' || asset === 'missing' || !asset.ephemeral)
        return;
    try {
        yield Asset_1.Asset.deleteOne({ _id: asset._id });
        yield workspaceStorage_1.spacesWorkspaceStorage.deleteByKey(asset.key);
    }
    catch (err) {
        console.error('Ephemeral asset cleanup error:', (0, logRedaction_1.redactForLog)(err));
    }
});
const parseZdrHistory = (history) => {
    const parsed = validation_1.zdrHistorySchema.safeParse(history !== null && history !== void 0 ? history : []);
    return parsed.success ? { ok: true, value: parsed.data } : { ok: false };
};
// Persist the user turn with its metrics. Trivially neutral prompts record
// llmSkipReason 'trivial' so the skip gate is distinguishable in the DB from
// failed ('parse'/'error') classification; non-trivial prompts get a
// fire-and-forget classification call back (docs/plan-17-prompt-metrics.md
// tasks 6 and 9). The gate is computed once and reused for both purposes.
const saveUserMessageWithMetrics = (sessionId, content, asset) => __awaiter(void 0, void 0, void 0, function* () {
    const triviallyNeutral = (0, metricsService_1.isTriviallyNeutral)(content);
    const userMessage = new Message_1.Message(Object.assign(Object.assign({ sessionId, role: 'user', content }, (asset ? { assetId: asset._id } : {})), { metrics: Object.assign(Object.assign({}, (yield buildMessageMetrics(sessionId, content))), (triviallyNeutral ? { llmSkipReason: 'trivial' } : {})) }));
    yield userMessage.save();
    // #226: record the session's most recent message time so the session list
    // orders by activity, not creation. Using the message's own timestamp (not
    // `new Date()`) keeps the stored value consistent with the message it
    // represents. Awaited so the sidebar order cannot lag the turn.
    yield Session_1.Session.updateOne({ _id: sessionId }, { $set: { lastMessageAt: userMessage.timestamp } });
    if (!triviallyNeutral) {
        (0, metricsService_1.classifyAndPersistPromptDimensions)(String(userMessage._id), content).catch((err) => console.error('Prompt classification error:', (0, logRedaction_1.redactForLog)(err)));
    }
    return userMessage;
});
/*
 * Entity-graph retrieval (#138, plan task 4): read-only, bounded "what we
 * know about you" block for the system prompt, only when
 * ENTITY_GRAPH_PROMPT_INJECTION is set. Never throws — graph enrichment,
 * like extraction, must not degrade a chat turn.
 */
const knowledgeBlockFor = (prompt, userId) => __awaiter(void 0, void 0, void 0, function* () {
    if (!(0, entityRetrievalService_1.isEntityInjectionEnabled)())
        return '';
    try {
        return yield (0, entityRetrievalService_1.retrieveKnowledgeBlock)(prompt, userId);
    }
    catch (err) {
        console.error('Entity graph retrieval error:', (0, logRedaction_1.redactForLog)(err));
        return '';
    }
});
// Chat endpoint (non-streaming, preserved for compatibility)
router.post('/', auth_1.authenticate, (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l;
    // Held outside try so the catch can erase a throwaway attachment on any
    // failure path (#116). Null until the asset is loaded.
    let attachedAsset = null;
    try {
        const { sessionId, content } = req.body;
        const userId = (_a = req.user) === null || _a === void 0 ? void 0 : _a.id;
        if (!content) {
            return res.status(400).json({ message: 'Content is required' });
        }
        if (!(yield (0, userService_1.hasPermission)(userId, userService_1.ROUTING_PERMISSION))) {
            return res.status(403).json({ message: NO_ROUTING_PERMISSION });
        }
        const attachResult = yield loadAttachedAsset(req);
        if (attachResult === 'invalid') {
            return res.status(400).json({ message: 'Invalid asset reference' });
        }
        if (attachResult === 'missing') {
            return res.status(404).json({ message: 'Asset not found' });
        }
        attachedAsset = attachResult;
        const userDoc = yield User_1.User.findById(userId);
        if (!userDoc) {
            return res.status(404).json({ message: 'User not found' });
        }
        // Abort the provider call when the client disconnects before the response
        // lands. Shared by the ZDR and persisted paths; symmetric with the
        // streaming route's wiring.
        const abortController = new AbortController();
        req.on('close', () => {
            if (!res.writableEnded)
                abortController.abort();
        });
        /*
         * One decision owns the turn's retention shape (#144, services/zdrTurn.ts):
         * reject / suppress-persistence + replay / persist normally. The flag is
         * the effective per-chat incognito state: for a new chat it comes from the
         * request's `zdr` intent (the chat toggle next to attach) or the account's
         * 'incognito by default'; for a sessionId turn it comes from the stored
         * session flag. The bridged account setting still rejects continuation
         * before the read (frozen #116 ordering — see the reject below).
         */
        const accountIncognito = Boolean((_b = userDoc.settings) === null || _b === void 0 ? void 0 : _b.zdr);
        const bodyIntent = typeof req.body.zdr === 'boolean' ? req.body.zdr : undefined;
        let session;
        let turnDecision;
        if (sessionId) {
            if (accountIncognito) {
                // Incognito accounts cannot continue a saved chat (#116/#144): the
                // reject fires before any session read.
                turnDecision = (0, zdrTurn_1.decideTurn)({ incognito: true, sessionId });
            }
            else {
                if (!(0, mongoose_1.isValidObjectId)(sessionId)) {
                    yield cleanupEphemeralAsset(attachedAsset);
                    return res.status(400).json({ message: 'Invalid session id' });
                }
                session = yield Session_1.Session.findOne({ _id: sessionId, userId, deletedAt: null });
                if (!session) {
                    return res.status(404).json({ message: 'Session not found' });
                }
                turnDecision = (0, zdrTurn_1.decideTurn)({ incognito: Boolean(session.incognito), sessionId });
            }
        }
        else {
            turnDecision = (0, zdrTurn_1.decideTurn)({
                incognito: bodyIntent !== null && bodyIntent !== void 0 ? bodyIntent : accountIncognito,
                sessionId: undefined,
            });
        }
        if (turnDecision.reject) {
            yield cleanupEphemeralAsset(attachedAsset);
            return res.status(409).json({
                message: 'Zero-data-retention is on — new turns are never stored, so they cannot continue a saved chat. Start a new chat instead.',
            });
        }
        const cleanupIfEphemeral = () => __awaiter(void 0, void 0, void 0, function* () {
            if (!turnDecision.requireEphemeralCleanup)
                return;
            yield cleanupEphemeralAsset(attachedAsset);
        });
        if (turnDecision.persistWithHistoryReplay) {
            // Zero-data retention (#116): nothing about the turn is written — no
            // Session row, no Message rows, no classification, no title. The
            // conversation continuity is the client's replayed `history` payload
            // (validation-gated).
            const zdrHistory = parseZdrHistory(req.body.history);
            if (!zdrHistory.ok) {
                // The turn is rejected before it consumes anything, so the throwaway
                // attachment does not outlive the request either (#116).
                yield cleanupIfEphemeral();
                return res.status(400).json({ message: 'Invalid chat history' });
            }
            yield (0, geoLocationService_1.ensureUserLocation)(userDoc, req.ip);
            // Plan task 8: ZDR/incognito turns DO retrieve the graph read-only
            // (Alex, 2026-09-21) — but they write nothing, and this branch an early
            // return before any persistence does exactly that. Extraction below
            // never runs for ZDR.
            const zdrEntityBlock = yield knowledgeBlockFor(content, userId);
            /*
             * ZDR continuity is the client replay; the prompt is assembled once and
             * raced (#232). Racing never calls the guard, so there is no library
             * index to inject on a raced turn.
             */
            const zdrMessages = () => {
                const turnMessages = buildZdrMessages(zdrHistory.value, content);
                turnMessages.unshift({
                    role: 'system',
                    content: (0, promptAssembly_1.buildSystemContent)(userDoc, zdrEntityBlock, ''),
                });
                appendAssetBlock(turnMessages, attachedAsset);
                return turnMessages;
            };
            // ZDR turns never carry image parts (no buildImageTurn on this path), so
            // image gating is moot: race the full text roster. An empty roster (no
            // model could be picked) is surfaced as the all-disabled error.
            const zdrPrePick = yield (0, racingService_1.pickRosterRoute)(false);
            if (!zdrPrePick)
                throw new modelConfigService_1.AllModelsDisabledError();
            const raced = yield (0, racingService_1.routeAndComplete)({
                messages: zdrMessages(),
                userId,
                abortSignal: abortController.signal,
            }, false);
            const routingResult = raced.routing;
            const chatCompletion = raced.outcome.result.completion;
            const zdrAssistantContent = (_e = (_d = (_c = chatCompletion.choices[0]) === null || _c === void 0 ? void 0 : _c.message) === null || _d === void 0 ? void 0 : _d.content) !== null && _e !== void 0 ? _e : '';
            // #195: a tool-only ZDR turn still ends with a short confirmation.
            const zdrConfirmation = zdrAssistantContent.trim()
                ? null
                : (0, exports.confirmationForToolResults)((_f = chatCompletion.toolResults) !== null && _f !== void 0 ? _f : []);
            const zdrFinalContent = zdrAssistantContent.trim()
                ? zdrAssistantContent
                : (zdrConfirmation !== null && zdrConfirmation !== void 0 ? zdrConfirmation : zdrAssistantContent);
            yield cleanupIfEphemeral();
            return res.json({
                routing: routingResult,
                message: {
                    role: 'assistant',
                    content: zdrFinalContent,
                    modelName: routingResult.model,
                },
            });
        }
        // On the sessionId path the session is already loaded above (the decision
        // needs the stored flag first). New persisted chats — the only way to get
        // here — are never incognito: an incognito turn returns in the replay
        // branch above without touching Session, so the flag is pinned to false
        // explicitly (a persisted incognito session would contradict the
        // write-nothing promise this ticket keeps).
        if (!session) {
            session = yield createSessionWithUser(userId, content, {
                incognito: false,
            });
        }
        // Save user message
        const userMessage = yield saveUserMessageWithMetrics(String(session._id), content, attachedAsset);
        // Image turns (#115) route vision-first only when the
        // presign path is actually available; otherwise the turn degrades to the
        // legacy text envelope and normal routing applies.
        const hasImage = turnsWithImage(attachedAsset);
        // Get chat history for context — the window includes the just-saved
        // current turn, reversing to oldest-first for the prompt.
        const history = yield Message_1.Message.find({ sessionId: session._id })
            .sort({ timestamp: -1 })
            .limit(10);
        // Coarse geolocation (#50): awaited so this turn's prompt can include the
        // country; cheap when cached (fresh/cooldown returns immediately) and the
        // service itself never throws, so chat cannot block hard on it.
        yield (0, geoLocationService_1.ensureUserLocation)(userDoc, req.ip);
        const entityBlock = yield knowledgeBlockFor(content, userId);
        /*
         * #238: the enrichment pass (bounded serial) decides whether to inject the
         * file-library index. Text-only: image turns skip it, matching the retired
         * guard. `enrichmentHistoryFromDocs` is non-mutating so the same `history`
         * array survives for `withSystemAndAsset`.
         */
        const libraryBlock = hasImage
            ? ''
            : yield (0, enrichmentService_1.enrichmentLibraryBlock)(content, enrichmentHistoryFromDocs(history, userMessage._id), userId);
        const withSystemAndAsset = (systemContent) => __awaiter(void 0, void 0, void 0, function* () {
            const next = messagesFromPersistedHistory(history);
            next.unshift({ role: 'system', content: systemContent });
            if (attachedAsset) {
                const imageAttached = hasImage ? yield buildImageTurn(next, attachedAsset) : false;
                if (!imageAttached)
                    appendAssetBlock(next, attachedAsset);
            }
            return next;
        });
        /*
         * #232: the turn races the fixed roster. Racing selects the model
         * internally, so the prompt is assembled once (#238: the enrichment pass
         * supplies the library block) and the budget is sized against the pre-race
         * pick's window. The winner re-shapes routing for persistence. An empty
         * roster (no model could be picked) is surfaced as the all-disabled error.
         */
        const rosterPrePick = yield (0, racingService_1.pickRosterRoute)(hasImage);
        if (!rosterPrePick)
            throw new modelConfigService_1.AllModelsDisabledError();
        const turnMessages = yield withSystemAndAsset((0, promptAssembly_1.buildSystemContent)(userDoc, entityBlock, libraryBlock));
        const raced = yield (0, racingService_1.routeAndComplete)({
            messages: turnMessages,
            max_tokens: (0, outputTokenCap_1.outputTokensFor)(rosterPrePick.contextLength, (0, outputTokenCap_1.promptCharsFrom)(turnMessages)),
            userId,
            abortSignal: abortController.signal,
            trace: { sessionId: String(session._id) },
        }, hasImage);
        const routingResult = raced.routing;
        const chatCompletion = raced.outcome.result.completion;
        // Empty provider responses persist as '' (fail-visibility, #4 J); the
        // UI presents the '(no content returned)' placeholder.
        const rawAssistantContent = (_j = (_h = (_g = chatCompletion.choices[0]) === null || _g === void 0 ? void 0 : _g.message) === null || _h === void 0 ? void 0 : _h.content) !== null && _j !== void 0 ? _j : '';
        const toolResults = (_k = chatCompletion.toolResults) !== null && _k !== void 0 ? _k : [];
        // #195: a tool-only turn ends with a synthesized confirmation instead of
        // silence (the model's own text, when present, is untouched).
        const assistantContent = rawAssistantContent.trim()
            ? rawAssistantContent
            : ((_l = (0, exports.confirmationForToolResults)(toolResults)) !== null && _l !== void 0 ? _l : rawAssistantContent);
        // Sources from any web_search the agent chose to run (issue #16),
        // persisted only when non-empty. Titles ride along (#33).
        let sources = [];
        const titles = new Map();
        for (const r of toolResults) {
            collectSourcesInto(sources, r.result, titles);
        }
        const sourceTitles = sources
            .filter((url) => titles.has(url))
            .map((url) => ({ url, title: titles.get(url) }));
        // Save assistant message
        const assistantMessage = new Message_1.Message(Object.assign(Object.assign(Object.assign(Object.assign({ sessionId: session._id, role: 'assistant', content: assistantContent, modelName: routingResult.model, provider: routingResult.provider }, (chatCompletion.usage ? { usage: chatCompletion.usage } : {})), (sources.length > 0 ? { sources } : {})), (sourceTitles.length > 0 ? { sourceTitles } : {})), { metrics: yield buildMessageMetrics(String(session._id), assistantContent) }));
        yield assistantMessage.save();
        // Entity graph extraction (#138): one extra LLM call after the turn is
        // served, fire-and-forget like title generation. Never runs for ZDR
        // chats (handled above), and only when ENTITY_GRAPH_ENABLED is set —
        // extraction is enrichment, so failures log and everything else
        // continues from here.
        if ((0, entityExtractionService_1.isEntityExtractionEnabled)()) {
            (0, entityExtractionService_1.extractAndPersistFromTurn)({
                userId: String(userDoc._id),
                sessionId: String(session._id),
                messageId: String(assistantMessage._id),
                userText: content,
                assistantText: assistantContent,
            }).catch((err) => console.error('Entity extraction error:', (0, logRedaction_1.redactForLog)(err)));
        }
        res.json({
            sessionId: session._id,
            message: assistantMessage,
            routing: routingResult,
        });
    }
    catch (err) {
        console.error('Chat error:', (0, logRedaction_1.redactForLog)(err));
        // A ZDR turn that fails mid-flight (routing, provider, geo, metrics) still
        // erases its throwaway attachment — cleanup is a no-op for durable
        // assets, so the persisted path is untouched (#116).
        yield cleanupEphemeralAsset(attachedAsset);
        // #168: every model cooled off after failures → the friendly message
        // becomes the primary error text.
        const allDisabled = err instanceof modelConfigService_1.AllModelsDisabledError;
        res.status(allDisabled ? 503 : 500).json({
            message: allDisabled ? (0, exports.streamingErrorMessage)(err) : 'Error processing chat',
            detail: (0, exports.streamingErrorMessage)(err),
        });
    }
}));
// Chat streaming endpoint (SSE)
router.post('/stream', auth_1.authenticate, (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _a, e_1, _b, _c;
    var _d, _e;
    // Held outside try so the catch can erase a throwaway attachment on any
    // failure path (#116); Safe: cleanup is a no-op for durable assets.
    let attachedAsset = null;
    try {
        const { sessionId, content } = req.body;
        const userId = (_d = req.user) === null || _d === void 0 ? void 0 : _d.id;
        if (!content) {
            return res.status(400).json({ message: 'Content is required' });
        }
        if (!(yield (0, userService_1.hasPermission)(userId, userService_1.ROUTING_PERMISSION))) {
            return res.status(403).json({ message: NO_ROUTING_PERMISSION });
        }
        const attachResult = yield loadAttachedAsset(req);
        if (attachResult === 'invalid') {
            return res.status(400).json({ message: 'Invalid asset reference' });
        }
        if (attachResult === 'missing') {
            return res.status(404).json({ message: 'Asset not found' });
        }
        attachedAsset = attachResult;
        const streamUserDoc = yield User_1.User.findById(userId);
        if (!streamUserDoc) {
            return res.status(404).json({ message: 'User not found' });
        }
        /*
         * One decision owns the turn's retention shape (#144, services/zdrTurn.ts),
         * mirroring the non-streaming route: the per-chat flag comes from the
         * request's `zdr` intent (new chat) or the account's 'incognito by
         * default'; a sessionId turn decides off the stored session flag. The
         * bridged account setting still rejects continuation before the read.
         */
        const accountIncognito = Boolean((_e = streamUserDoc.settings) === null || _e === void 0 ? void 0 : _e.zdr);
        const bodyIntent = typeof req.body.zdr === 'boolean' ? req.body.zdr : undefined;
        let session;
        let turnDecision;
        if (sessionId) {
            if (accountIncognito) {
                // Incognito accounts cannot continue a saved chat (#116/#144): the
                // reject fires before any session read.
                turnDecision = (0, zdrTurn_1.decideTurn)({ incognito: true, sessionId });
            }
            else {
                if (!(0, mongoose_1.isValidObjectId)(sessionId)) {
                    yield cleanupEphemeralAsset(attachedAsset);
                    return res.status(400).json({ message: 'Invalid session id' });
                }
                session = yield Session_1.Session.findOne({ _id: sessionId, userId, deletedAt: null });
                if (!session) {
                    return res.status(404).json({ message: 'Session not found' });
                }
                turnDecision = (0, zdrTurn_1.decideTurn)({ incognito: Boolean(session.incognito), sessionId });
            }
        }
        else {
            turnDecision = (0, zdrTurn_1.decideTurn)({
                incognito: bodyIntent !== null && bodyIntent !== void 0 ? bodyIntent : accountIncognito,
                sessionId: undefined,
            });
        }
        if (turnDecision.reject) {
            yield cleanupEphemeralAsset(attachedAsset);
            return res.status(409).json({
                message: 'Zero-data-retention is on — new turns are never stored, so they cannot continue a saved chat. Start a new chat instead.',
            });
        }
        const cleanupIfEphemeral = () => __awaiter(void 0, void 0, void 0, function* () {
            if (!turnDecision.requireEphemeralCleanup)
                return;
            yield cleanupEphemeralAsset(attachedAsset);
        });
        const zdr = turnDecision.persistWithHistoryReplay;
        let zdrHistory = [];
        if (zdr) {
            // Zero-data retention (#116): see the non-streaming route's rationale —
            // no session is created, and saved chats cannot be continued.
            const parsedHistory = parseZdrHistory(req.body.history);
            if (!parsedHistory.ok) {
                yield cleanupIfEphemeral();
                return res.status(400).json({ message: 'Invalid chat history' });
            }
            zdrHistory = parsedHistory.value;
        }
        else if (!sessionId) {
            session = yield createSessionWithUser(userId, content, { incognito: false });
        }
        let routingResult;
        let messages;
        // Image turns (#115): gate on both the content type and a configured
        // presign path; the image part replaces the filename envelope this turn.
        const hasImage = turnsWithImage(attachedAsset);
        /*
         * #232: the primary model comes from the weighted roster pick (no guard
         * classifier). The actual race runs after the messages are assembled (the
         * race needs the full prompt); this pick only supplies the `contextLength`
         * for the output budget and the pre-race `meta` routing. An empty roster
         * (no model could be picked) is surfaced as the all-disabled error.
         */
        const rosterRoute = yield (0, racingService_1.pickRosterRoute)(hasImage);
        if (!rosterRoute)
            throw new modelConfigService_1.AllModelsDisabledError();
        yield (0, geoLocationService_1.ensureUserLocation)(streamUserDoc, req.ip);
        /*
         * #238: the enrichment pass supplies the file-library block (empty on ZDR —
         * the write-nothing turn injects no index, as before — and on image turns,
         * which are text-only for enrichment).
         */
        let libraryBlock = '';
        if (zdr) {
            // Continuity comes from the client replay (#116); nothing is read back.
            messages = buildZdrMessages(zdrHistory, content);
            routingResult = rosterRoute;
        }
        else {
            // Save user message
            const userMessage = yield saveUserMessageWithMetrics(String(session._id), content, attachedAsset);
            // Get chat history — the window includes the just-saved current turn,
            // reversing to oldest-first for the prompt.
            const history = yield Message_1.Message.find({ sessionId: session._id })
                .sort({ timestamp: -1 })
                .limit(10);
            if (!hasImage) {
                libraryBlock = yield (0, enrichmentService_1.enrichmentLibraryBlock)(content, enrichmentHistoryFromDocs(history, userMessage._id), userId);
            }
            // Same image-turn gating as the non-streaming route (#115).
            routingResult = rosterRoute;
            messages = messagesFromPersistedHistory(history);
        }
        const streamEntityBlock = yield knowledgeBlockFor(content, userId);
        messages.unshift({
            role: 'system',
            content: (0, promptAssembly_1.buildSystemContent)(streamUserDoc, streamEntityBlock, libraryBlock),
        });
        if (attachedAsset) {
            const imageAttached = hasImage ? yield buildImageTurn(messages, attachedAsset) : false;
            if (!imageAttached)
                appendAssetBlock(messages, attachedAsset);
        }
        // Set SSE headers
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();
        const sendEvent = (event, data) => {
            res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };
        let assistantContent = '';
        let sources = [];
        const titles = new Map();
        // #195: every executed tool of the turn, in order, so a turn that ends
        // with no assistant text can still be confirmed.
        const toolResults = [];
        // Reconciled tool events for this turn (#196). Raw SSE 'tool' frames keep
        // firing unchanged; this array is the deduped, persisted companion that
        // the 'done' message and a later refresh read from.
        const toolEvents = [];
        // #224: token usage for the turn, surfaced by the connector as a single
        // trailing `usage` chunk. Absent when the provider reported nothing.
        let usage;
        // Abort the provider call when the client disconnects mid-stream. 'close'
        // also fires after a normal end, so only abort when the response did not
        // finish cleanly.
        const abortController = new AbortController();
        req.on('close', () => {
            if (!res.writableEnded)
                abortController.abort();
        });
        try {
            sendEvent('meta', Object.assign(Object.assign({}, (zdr ? {} : { sessionId: session._id })), { routing: routingResult }));
            /*
             * #232: `routeAndStream` hedges the weighted primary's providers, aborts
             * the loser, and does its own roster fallback (retrying the next model
             * on total failure). The winner's model/provider replace the pre-race
             * pick for persistence.
             */
            const raced = yield (0, racingService_1.routeAndStream)(Object.assign({ messages, 
                // #104: budget sized against the picked model's window.
                max_tokens: (0, outputTokenCap_1.outputTokensFor)(routingResult.contextLength, (0, outputTokenCap_1.promptCharsFrom)(messages)), userId, abortSignal: abortController.signal }, (zdr ? {} : { trace: { sessionId: String(session._id) } })), hasImage);
            routingResult = raced.routing;
            const stream = raced.outcome.result.stream;
            try {
                for (var _f = true, stream_1 = __asyncValues(stream), stream_1_1; stream_1_1 = yield stream_1.next(), _a = stream_1_1.done, !_a; _f = true) {
                    _c = stream_1_1.value;
                    _f = false;
                    const chunk = _c;
                    // #224: the connector may emit one trailing usage chunk; capture it
                    // and continue without forwarding it as a delta/tool event.
                    if (chunk.usage) {
                        usage = chunk.usage;
                        continue;
                    }
                    // Tool feedback (issue #33): structured events replace the single
                    // prose status hint — the call event names the tool + query, the
                    // result event carries a compact outcome summary.
                    if (chunk.toolCall) {
                        const ev = toolCallEvent(chunk.toolCall);
                        (0, exports.reconcileToolEvent)(toolEvents, ev);
                        sendEvent('tool', ev);
                    }
                    if (chunk.toolResult) {
                        const ev = toolResultEvent(chunk.toolResult);
                        (0, exports.reconcileToolEvent)(toolEvents, ev);
                        sendEvent('tool', ev);
                        collectSourcesInto(sources, chunk.toolResult.result, titles);
                        toolResults.push(chunk.toolResult);
                    }
                    const delta = chunk.delta;
                    if (delta) {
                        assistantContent += delta;
                        sendEvent('delta', { content: delta });
                    }
                }
            }
            catch (e_1_1) { e_1 = { error: e_1_1 }; }
            finally {
                try {
                    if (!_f && !_a && (_b = stream_1.return)) yield _b.call(stream_1);
                }
                finally { if (e_1) throw e_1.error; }
            }
        }
        catch (err) {
            console.error('Streaming error for %s/%s:', routingResult.provider, routingResult.model, (0, logRedaction_1.redactForLog)(err));
            sendEvent('error', { message: (0, exports.streamingErrorMessage)(err) });
            sendEvent('done', { complete: false });
            yield cleanupEphemeralAsset(attachedAsset);
            res.end();
            return;
        }
        // #195: if the turn ran a user-facing tool but streamed no assistant
        // text — the Mastra-documented "run ends on a tool call" case, e.g. the
        // step cap landing on a tool round — emit a short confirmation as a
        // normal `delta` so the client renders it exactly like model text. A
        // turn that errored above returned already and is never confirmed.
        if (!assistantContent.trim()) {
            const confirmation = (0, exports.confirmationForToolResults)(toolResults);
            if (confirmation) {
                assistantContent = confirmation;
                sendEvent('delta', { content: confirmation });
            }
        }
        // Save assistant message. A provider stream that yields no (or only
        // empty) deltas still persists a turn with content: '' — the empty
        // response stays visible as '(no content returned)' in the UI (#4 J).
        // ZDR turns (#116) save nothing: the answer rides the 'done' event only,
        // and the ephemeral attachment, if any, is erased with it.
        const sourceTitleList = sources
            .filter((url) => titles.has(url))
            .map((url) => ({ url, title: titles.get(url) }));
        if (zdr) {
            // #196 (D6): reconciled tool summaries are deliberately not attached to
            // ZDR `done` payloads — the turn is not stored, matching the existing
            // "nothing is written" contract. Live 'tool' frames still stream.
            if (!(0, metricsService_1.isTriviallyNeutral)(content) && assistantContent) {
                // Suggestions are still generated (cheap guard model) — they are
                // delivered without ever being written anywhere.
                const suggestions = yield (0, followupService_1.generateFollowups)(content, assistantContent);
                sendEvent('done', Object.assign({ complete: true, message: Object.assign({ role: 'assistant', content: assistantContent, modelName: routingResult.model }, (suggestions.length > 0 ? { suggestions } : {})) }, (sourceTitleList.length > 0 ? { sourceTitles: sourceTitleList } : {})));
                yield cleanupEphemeralAsset(attachedAsset);
                res.end();
                return;
            }
            sendEvent('done', Object.assign({ complete: true, message: {
                    role: 'assistant',
                    content: assistantContent,
                    modelName: routingResult.model,
                } }, (sourceTitleList.length > 0 ? { sourceTitles: sourceTitleList } : {})));
            yield cleanupEphemeralAsset(attachedAsset);
            res.end();
            return;
        }
        const assistantMessage = new Message_1.Message(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign({ sessionId: session._id, role: 'assistant', provider: routingResult.provider, content: assistantContent, modelName: routingResult.model }, (usage ? { usage } : {})), (sources.length > 0 ? { sources } : {})), (sourceTitleList.length > 0 ? { sourceTitles: sourceTitleList } : {})), (toolEvents.length > 0 ? { tools: toolEvents } : {})), { metrics: yield buildMessageMetrics(String(session._id), assistantContent) }));
        yield assistantMessage.save();
        if ((0, entityExtractionService_1.isEntityExtractionEnabled)()) {
            (0, entityExtractionService_1.extractAndPersistFromTurn)({
                userId: String(streamUserDoc._id),
                sessionId: String(session._id),
                messageId: String(assistantMessage._id),
                userText: content,
                assistantText: assistantContent,
            }).catch((err) => console.error('Entity extraction error:', (0, logRedaction_1.redactForLog)(err)));
        }
        // Follow-up suggestions (issue #33): generated with the cheap guard
        // model, reusing the title/classification service pattern. Skipped for
        // trivially neutral prompts and empty turns so the 'trivial' skip gate
        // stays consistent; the client falls back to static placeholders when
        // the field is absent.
        if (!(0, metricsService_1.isTriviallyNeutral)(content) && assistantContent) {
            const suggestions = yield (0, followupService_1.generateFollowups)(content, assistantContent);
            if (suggestions.length > 0) {
                assistantMessage.suggestions = suggestions;
                yield assistantMessage.save();
            }
        }
        sendEvent('done', Object.assign({ complete: true, message: assistantMessage }, (sourceTitleList.length > 0 ? { sourceTitles: sourceTitleList } : {})));
        res.end();
    }
    catch (err) {
        console.error('Chat stream error:', (0, logRedaction_1.redactForLog)(err));
        // A ZDR turn that fails before or during streaming still erases its
        // throwaway attachment (#116); no-op for durable assets.
        yield cleanupEphemeralAsset(attachedAsset);
        if (!res.headersSent) {
            // #168: every model cooled off before the stream opened (the
            // pre-stream routeQuery throws) → the friendly message is the
            // primary text, mirroring the non-streaming route. The client
            // surfaces it on 503 like it does the 403 geo message.
            const allDisabled = err instanceof modelConfigService_1.AllModelsDisabledError;
            res.status(allDisabled ? 503 : 500).json({
                message: allDisabled ? (0, exports.streamingErrorMessage)(err) : 'Error processing chat',
                detail: (0, exports.streamingErrorMessage)(err),
            });
        }
        else {
            res.end();
        }
    }
}));
// Soft-delete a session
router.delete('/sessions/:id', auth_1.authenticate, (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _a;
    try {
        const updated = yield Session_1.Session.findOneAndUpdate({ _id: req.params.id, userId: (_a = req.user) === null || _a === void 0 ? void 0 : _a.id, deletedAt: null }, { deletedAt: new Date() });
        if (!updated) {
            return res.status(404).json({ message: 'Session not found' });
        }
        res.json({ success: true });
    }
    catch (_err) {
        res.status(500).json({ message: 'Error deleting session' });
    }
}));
// Get all sessions for user
router.get('/sessions', auth_1.authenticate, (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _a;
    try {
        const userId = (_a = req.user) === null || _a === void 0 ? void 0 : _a.id;
        // #226: order by most recent message. Null lastMessageAt (never-messaged
        // sessions) sorts last under a descending sort; createdAt breaks ties
        // among those nulls (and among equal timestamps) by creation order.
        const sessions = yield Session_1.Session.find({ userId, deletedAt: null }).sort({
            lastMessageAt: -1,
            createdAt: -1,
        });
        res.json(sessions);
    }
    catch (_err) {
        res.status(500).json({ message: 'Error fetching sessions' });
    }
}));
// Get messages for a session
router.get('/sessions/:id', auth_1.authenticate, (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _a;
    try {
        const userId = (_a = req.user) === null || _a === void 0 ? void 0 : _a.id;
        const session = yield Session_1.Session.findOne({ _id: req.params.id, userId, deletedAt: null });
        if (!session) {
            return res.status(404).json({ message: 'Session not found' });
        }
        const messages = yield Message_1.Message.find({ sessionId: session._id }).sort({
            timestamp: 1,
        });
        res.json({ session, messages });
    }
    catch (_err) {
        res.status(500).json({ message: 'Error fetching session messages' });
    }
}));
exports.default = router;
