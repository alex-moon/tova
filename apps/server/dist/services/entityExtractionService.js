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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractAndPersistFromTurn = exports.validEdgeCandidates = exports.validEntityCandidates = exports.parseExtraction = exports.normalizeName = exports.isEntityExtractionEnabled = void 0;
const mongoose_1 = __importDefault(require("mongoose"));
const inferenceService_1 = require("./inferenceService");
const Entity_1 = require("../models/Entity");
const logRedaction_1 = require("./logRedaction");
const EntityEdge_1 = require("../models/EntityEdge");
const config_1 = require("../config");
/*
 * Per-user entity graph extraction (issue #138, plan-138 task 2). One
 * fire-and-forget tool-free LLM call per completed turn — the titleService
 * pattern — that pulls durable real-world entities and *stated* relationships
 * out of the exchange and merges them into the per-user graph. Every failure
 * degrades to a log entry: the graph is enrichment, never load-bearing, so a
 * bad extraction must not fail a chat turn that has already been served.
 */
// #238: aux model source (was `ROUTER_SMALL_MODEL`), read lazily.
const extractionModel = () => config_1.config.aux.model;
// Plan-138 decision 6: extraction stays off until the flag is set, so the
// extra LLM call can be disabled instantly without a deploy.
const isEntityExtractionEnabled = () => Boolean(process.env.ENTITY_GRAPH_ENABLED);
exports.isEntityExtractionEnabled = isEntityExtractionEnabled;
const EXTRACTION_PROMPT = 'You extract a memory graph from a chat exchange. From the user statement and the ' +
    'assistant reply, identify durable real-world entities (a person, place, organization, ' +
    'project, task, event, commitment, or preference the user has) and relationships ' +
    'between them. Ignore code, generic concepts, and anything the assistant merely cited. ' +
    'State a relationship ONLY when the text actually links the two entities (a plan, ' +
    'involvement, gate/signoff, preference, or location-style tie). ' +
    'Tag each entity `salience: "high"` ONLY when it is emotionally significant to the user ' +
    '(a family event, a strong personal preference); default to "low". ' +
    'Reply with ONLY a JSON object, no prose or code fences, shaped exactly like: ' +
    '{"entities":[{"name":"...","kind":"person|place|organization|project|task|event|commitment|preference","summary":"one sentence","salience":"low|high"}],' +
    '"edges":[{"from":"entity name","to":"entity name","kind":"involved-party|plan|prefers|located-in|gate","summary":"one sentence"}]} ' +
    'If there is nothing durable, reply {"entities":[],"edges":[]}';
const KIND_PATTERN = /^[a-z][a-z-]*$/;
const normalizeName = (name) => name.toLowerCase().replace(/\s+/g, ' ').trim();
exports.normalizeName = normalizeName;
/*
 * Extraction output is untrusted (plan-138 task 2b): the model may wrap the
 * JSON in fences, prefix prose, or emit a truncated tail. The parse salvages
 * the structure or returns null; the candidate validators below then skip
 * junk entries one by one rather than poisoning the graph.
 */
const parseExtraction = (raw) => {
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced ? fenced[1] : raw;
    try {
        return JSON.parse(candidate);
    }
    catch (_a) {
        // Not clean JSON: try the widest {..} span before giving up.
    }
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end <= start)
        return null;
    try {
        return JSON.parse(candidate.slice(start, end + 1));
    }
    catch (_b) {
        return null;
    }
};
exports.parseExtraction = parseExtraction;
const cleanSummary = (value) => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
const validEntityCandidates = (parsed) => {
    const list = parsed === null || parsed === void 0 ? void 0 : parsed.entities;
    if (!Array.isArray(list))
        return [];
    return list
        .filter((item) => typeof item === 'object' && item !== null)
        .filter((item) => typeof item.name === 'string' && item.name.trim() !== '')
        .filter((item) => typeof item.kind === 'string' && KIND_PATTERN.test(item.kind.trim()))
        .map((item) => ({
        name: item.name.trim(),
        kind: item.kind.trim().toLowerCase(),
        summary: cleanSummary(item.summary),
        salience: item.salience === 'high' ? 'high' : 'low',
    }));
};
exports.validEntityCandidates = validEntityCandidates;
const validEdgeCandidates = (parsed) => {
    const list = parsed === null || parsed === void 0 ? void 0 : parsed.edges;
    if (!Array.isArray(list))
        return [];
    return list
        .filter((item) => typeof item === 'object' && item !== null)
        .filter((item) => typeof item.from === 'string' &&
        item.from.trim() !== '' &&
        typeof item.to === 'string' &&
        item.to.trim() !== '' &&
        typeof item.kind === 'string' &&
        KIND_PATTERN.test(item.kind.trim()))
        .filter((item) => (0, exports.normalizeName)(item.from) !== (0, exports.normalizeName)(item.to))
        .map((item) => ({
        from: item.from.trim(),
        to: item.to.trim(),
        kind: item.kind.trim().toLowerCase(),
        summary: cleanSummary(item.summary),
    }));
};
exports.validEdgeCandidates = validEdgeCandidates;
/*
 * Merge-or-create (plan decision 3): identity is exact match on
 * {(userId, normalizedName, kind)}. The upsert bumps mentionCount and
 * lastMentionedAt on the match path and only sets name/kind on insert, so a
 * repeated mention reuses the existing node — never a second one. A failed
 * upsert (e.g. a race across concurrent turns) logs and skips, never throws.
 *
 * Confidence (plan task 7): a fresh node starts at LOW_CONFIDENCE; a merge
 * applies the saturating bump computed from the pre-update value (read-
 * modify-write on a tiny race window — far less frequent than it sounds,
 * and a missed bump merely slows a node's rise, never loses data). Salience
 * can only rise from a re-mention: a commute habit never earns salience, and
 * using salience in retrieval is deliberately out of scope (plan task 7f).
 */
const upsertEntity = (userId, candidate, input) => __awaiter(void 0, void 0, void 0, function* () {
    var _a, _b, _c;
    const sourceRef = {
        sessionId: new mongoose_1.default.Types.ObjectId(input.sessionId),
        messageId: new mongoose_1.default.Types.ObjectId(input.messageId),
    };
    try {
        const prior = yield Entity_1.Entity.findOneAndUpdate({
            userId: new mongoose_1.default.Types.ObjectId(userId),
            normalizedName: (0, exports.normalizeName)(candidate.name),
            kind: candidate.kind,
        }, {
            $setOnInsert: Object.assign(Object.assign({ name: candidate.name, kind: candidate.kind, confidence: Entity_1.LOW_CONFIDENCE, salience: candidate.salience }, (candidate.summary ? { summary: candidate.summary } : {})), { sourceRefs: [sourceRef] }),
        }, { upsert: true });
        if (!prior) {
            const inserted = yield Entity_1.Entity.findOne({
                userId: new mongoose_1.default.Types.ObjectId(userId),
                normalizedName: (0, exports.normalizeName)(candidate.name),
                kind: candidate.kind,
            });
            return (_a = inserted === null || inserted === void 0 ? void 0 : inserted._id) !== null && _a !== void 0 ? _a : null;
        }
        const bump = (0, Entity_1.bumpConfidence)((_b = prior.confidence) !== null && _b !== void 0 ? _b : Entity_1.LOW_CONFIDENCE);
        yield Entity_1.Entity.updateOne({ _id: prior._id }, {
            $set: {
                lastMentionedAt: new Date(),
                confidence: bump,
                // `?? 'low'`: a legacy doc without the field must not get a null
                // salience written by $set (the schema default only runs on insert).
                salience: candidate.salience === 'high' ? 'high' : ((_c = prior.salience) !== null && _c !== void 0 ? _c : 'low'),
            },
            $inc: { mentionCount: 1 },
            $push: { sourceRefs: sourceRef },
        });
        return prior._id;
    }
    catch (err) {
        console.error('Entity upsert error:', (0, logRedaction_1.redactForLog)(candidate.name), (0, logRedaction_1.redactForLog)(candidate.kind), (0, logRedaction_1.redactForLog)(err));
        return null;
    }
});
const upsertEdge = (userId, fromEntityId, toEntityId, candidate, input) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        yield EntityEdge_1.EntityEdge.findOneAndUpdate({
            userId: new mongoose_1.default.Types.ObjectId(userId),
            fromEntityId,
            toEntityId,
            kind: candidate.kind,
        }, {
            $setOnInsert: Object.assign({}, (candidate.summary ? { summary: candidate.summary } : {})),
            $push: {
                sourceRefs: {
                    sessionId: new mongoose_1.default.Types.ObjectId(input.sessionId),
                    messageId: new mongoose_1.default.Types.ObjectId(input.messageId),
                },
            },
        }, { upsert: true });
    }
    catch (err) {
        console.error('Entity edge upsert error:', (0, logRedaction_1.redactForLog)(err));
    }
});
/*
 * The core per-turn extraction: LLM call → tolerant parse → merge-or-create →
 * edges only where both endpoints resolved to graph nodes. Creates nothing
 * when the LLM call or parse fails, and never rethrows.
 */
const extractAndPersistFromTurn = (input) => __awaiter(void 0, void 0, void 0, function* () {
    var _a, _b, _c, _d;
    const trimmedExchange = `${input.userText.replace(/\s+/g, ' ').trim()}\n\nAssistant replied:\n` +
        `${input.assistantText.replace(/\s+/g, ' ').trim()}`;
    try {
        const completion = yield inferenceService_1.inferenceService.createToolFreeCompletion({
            provider: config_1.config.aux.provider,
            model: extractionModel(),
            messages: [
                { role: 'system', content: EXTRACTION_PROMPT },
                { role: 'user', content: trimmedExchange.substring(0, 4000) },
            ],
            temperature: 0.2,
            // Reasoning tokens from the small model eat into this budget before
            // any JSON text (titleService precedent: 30 was far too small there).
            max_tokens: 1024,
            trace: { sessionId: input.sessionId, tags: ['entity-graph-extract'] },
        });
        const raw = (_c = (_b = (_a = completion.choices[0]) === null || _a === void 0 ? void 0 : _a.message) === null || _b === void 0 ? void 0 : _b.content) !== null && _c !== void 0 ? _c : '';
        const parsed = (0, exports.parseExtraction)(raw);
        if (!parsed || typeof parsed !== 'object') {
            // Junk model output: nothing durable, nothing written (plan 2f).
            return;
        }
        // Edge endpoints are named, not kind-tagged, so resolution is by
        // normalized name only; an ambiguous name (same name, several kinds) is
        // skipped — silently mis-linking nodes is worse than dropping an edge.
        const nodesByName = new Map();
        // A single turn may name the same entity more than once (or the model may
        // emit it twice). Confidence bumps mean *cross-chat* confirmation ("what
        // fires together wires together"), so a node is merged into the graph at
        // most once per turn — dedupe on the identity key up front.
        const seen = new Set();
        for (const candidate of (0, exports.validEntityCandidates)(parsed)) {
            const key = `${(0, exports.normalizeName)(candidate.name)}\u0000${candidate.kind}`;
            if (seen.has(key))
                continue;
            seen.add(key);
            const id = yield upsertEntity(input.userId, candidate, input);
            if (!id)
                continue;
            const nameKey = (0, exports.normalizeName)(candidate.name);
            const existing = (_d = nodesByName.get(nameKey)) !== null && _d !== void 0 ? _d : [];
            existing.push(id);
            nodesByName.set(nameKey, existing);
        }
        const resolve = (name) => {
            const ids = nodesByName.get((0, exports.normalizeName)(name));
            return ids && ids.length === 1 ? ids[0] : null;
        };
        for (const edge of (0, exports.validEdgeCandidates)(parsed)) {
            const from = resolve(edge.from);
            const to = resolve(edge.to);
            if (!from || !to)
                continue;
            yield upsertEdge(input.userId, from, to, edge, input);
        }
    }
    catch (err) {
        console.error('Entity extraction error:', (0, logRedaction_1.redactForLog)(err));
    }
});
exports.extractAndPersistFromTurn = extractAndPersistFromTurn;
