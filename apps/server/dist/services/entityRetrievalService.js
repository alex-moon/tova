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
exports.retrieveKnowledgeBlock = exports.buildKnowledgeBlock = exports.pickTopEntities = exports.scoreEntity = exports.promptWords = exports.isEntityInjectionEnabled = void 0;
const mongoose_1 = __importDefault(require("mongoose"));
const Entity_1 = require("../models/Entity");
const EntityEdge_1 = require("../models/EntityEdge");
const entityExtractionService_1 = require("./entityExtractionService");
/*
 * Prompt-assembly retrieval (issue #138, plan-138 task 3). Pure selection —
 * score a candidate pool of nodes against the current user prompt, then
 * materialise a compact "what we know about you" block with a hard character
 * cap (plan decision 7). The scoring part is pure so it is fully
 * unit-testable without Mongo.
 */
// Plan decision 6: injection has its own flag so prompt growth can be turned
// off (or never turned on) without touching extraction.
const isEntityInjectionEnabled = () => Boolean(process.env.ENTITY_GRAPH_PROMPT_INJECTION);
exports.isEntityInjectionEnabled = isEntityInjectionEnabled;
const WORD_PATTERN = /[a-z0-9']+/g;
// Stopwords that carry no linking signal; "the hotel" prompts still match a
// node named "Hotel Sahara" via 'hotel', but 'the'/'near' alone must not
// surface unrelated nodes.
const STOPWORDS = new Set([
    'a',
    'an',
    'the',
    'and',
    'or',
    'for',
    'to',
    'of',
    'in',
    'on',
    'near',
    'at',
    'is',
    'it',
    'my',
    'me',
    'you',
    'we',
    'i',
    'be',
    'are',
    'was',
]);
const promptWords = (prompt) => {
    var _a;
    const words = (_a = (0, entityExtractionService_1.normalizeName)(prompt).match(WORD_PATTERN)) !== null && _a !== void 0 ? _a : [];
    return new Set(words.filter((word) => word.length > 1 && !STOPWORDS.has(word)));
};
exports.promptWords = promptWords;
/*
 * Deterministic score = keyword overlap (the dominant signal) × 10 +
 * log-scaled mention frequency + recency bonus. Keyword overlap of zero
 * scores 0 — recency alone must not drag irrelevant nodes into the block,
 * but such nodes stay in the pool so pure-recency trends remain observable.
 */
const scoreEntity = (prompt, entity) => {
    var _a, _b;
    const words = (0, exports.promptWords)(prompt);
    const nameWords = (_a = (0, entityExtractionService_1.normalizeName)(entity.name).match(WORD_PATTERN)) !== null && _a !== void 0 ? _a : [];
    let overlap = nameWords.filter((word) => words.has(word)).length;
    if (entity.summary) {
        const summaryWords = (_b = (0, entityExtractionService_1.normalizeName)(entity.summary).match(WORD_PATTERN)) !== null && _b !== void 0 ? _b : [];
        overlap += summaryWords.filter((word) => words.has(word)).length;
    }
    if (overlap === 0)
        return 0;
    const ageDays = Math.max(0, Date.now() - new Date(entity.lastMentionedAt).getTime()) / 86400000;
    return overlap * 10 + Math.log(1 + entity.mentionCount) + Math.max(0, 5 - ageDays);
};
exports.scoreEntity = scoreEntity;
const pickTopEntities = (prompt, nodes, n = 8) => nodes
    .map((entity) => ({ entity, score: (0, exports.scoreEntity)(prompt, entity) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, n);
exports.pickTopEntities = pickTopEntities;
const BLOCK_CAP = 1500;
const oneLine = (text, cap = 120) => {
    const line = text.replace(/\s+/g, ' ').trim();
    return line.length > cap ? `${line.substring(0, cap - 1)}…` : line;
};
const buildKnowledgeBlock = (prompt, nodes, edges, n = 8, cap = BLOCK_CAP) => {
    var _a, _b;
    const picked = (0, exports.pickTopEntities)(prompt, nodes, n);
    if (picked.length === 0)
        return '';
    const nameById = new Map(picked.map(({ entity }) => [String(entity._id), entity.name]));
    const selectedIds = new Set(nameById.keys());
    const lines = [];
    let used = 0;
    for (const { entity } of picked) {
        const details = [`${entity.kind}: ${entity.name}`];
        if (entity.summary)
            details.push(entity.summary);
        details.push(`mentioned ${entity.mentionCount} times`);
        const line = `- ${details.join(' — ')}`;
        if (used + line.length > cap)
            break;
        lines.push(line);
        used += line.length;
    }
    for (const edge of edges) {
        if (!selectedIds.has(edge.fromId) && !selectedIds.has(edge.toId))
            continue;
        const edgeLine = `- ${(_a = nameById.get(edge.fromId)) !== null && _a !== void 0 ? _a : edge.fromName} —${edge.kind}→ ` +
            `${(_b = nameById.get(edge.toId)) !== null && _b !== void 0 ? _b : edge.toName}` +
            (edge.summary ? ` (${oneLine(edge.summary, 80)})` : '');
        // A missing name on either endpoint (deleted node or truncated fetch)
        // renders an empty bullet — drop the edge line instead.
        if (!nameById.get(edge.fromId) && !edge.fromName)
            continue;
        if (!nameById.get(edge.toId) && !edge.toName)
            continue;
        if (used + edgeLine.length > cap)
            break;
        lines.push(edgeLine);
        used += edgeLine.length;
    }
    return lines.join('\n');
};
exports.buildKnowledgeBlock = buildKnowledgeBlock;
/*
 * Mongo-backed selection: a recent bounded pool (plan decision: recency
 * order for cheap candidate recursion, then scoring picks the winners) plus
 * the direct edges of the survivors. Empty block when nothing is relevant.
 */
const retrieveKnowledgeBlock = (prompt_1, userId_1, ...args_1) => __awaiter(void 0, [prompt_1, userId_1, ...args_1], void 0, function* (prompt, userId, n = 8) {
    const pool = yield Entity_1.Entity.find({
        userId: new mongoose_1.default.Types.ObjectId(userId),
        // Plan task 7: confidence-gated. Only HIGH-confidence nodes — "what fires
        // together wires together", saturated past the threshold — reach the
        // block; the very start of a user's graph therefore injects nothing,
        // deliberately. Pre-confidence docs (no field) read as low and stay out.
        confidence: { $gte: Entity_1.HIGH_CONFIDENCE },
    })
        .sort({ lastMentionedAt: -1 })
        .limit(100)
        .lean();
    if (pool.length === 0)
        return '';
    const picked = (0, exports.pickTopEntities)(prompt, pool, n);
    if (picked.length === 0)
        return '';
    const ids = picked.map((entry) => entry.entity._id);
    const edges = yield EntityEdge_1.EntityEdge.find({
        userId: new mongoose_1.default.Types.ObjectId(userId),
        $or: [{ fromEntityId: { $in: ids } }, { toEntityId: { $in: ids } }],
    })
        .limit(50)
        .lean();
    // Endpoint names: the picked side comes from scoring, the far side needs a
    // name lookup so edge lines stay human-readable even though the far node
    // is not part of the selected set.
    const farIds = edges.flatMap((edge) => [
        edge.fromEntityId,
        edge.toEntityId,
    ]);
    const nameDocs = yield Entity_1.Entity.find({ _id: { $in: farIds } })
        .select('name')
        .lean();
    const nameById = new Map([
        ...picked.map(({ entity }) => [String(entity._id), entity.name]),
        ...nameDocs.map((doc) => [String(doc._id), doc.name]),
    ]);
    return (0, exports.buildKnowledgeBlock)(prompt, pool, edges.map((edge) => {
        var _a, _b, _c;
        return ({
            fromId: String(edge.fromEntityId),
            toId: String(edge.toEntityId),
            fromName: (_a = nameById.get(String(edge.fromEntityId))) !== null && _a !== void 0 ? _a : '',
            toName: (_b = nameById.get(String(edge.toEntityId))) !== null && _b !== void 0 ? _b : '',
            kind: edge.kind,
            summary: (_c = edge.summary) !== null && _c !== void 0 ? _c : undefined,
        });
    }), n);
});
exports.retrieveKnowledgeBlock = retrieveKnowledgeBlock;
