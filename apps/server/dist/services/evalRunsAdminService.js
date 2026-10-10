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
exports.getEvalRun = exports.listEvalRuns = exports.clampLimit = exports.MAX_LIMIT = void 0;
/*
 * #225 read side for the admin Evals tab: the stored rollup is projected into
 * shared wire shapes here so routes stay thin (same split as
 * langsmithTracesService / adminLangsmith). Reads Mongo only — the tab never
 * re-queries LangSmith per page load (Decision 1).
 */
const EvalRunRecord_1 = require("../models/EvalRunRecord");
const DEFAULT_LIMIT = 30;
exports.MAX_LIMIT = 100;
const clampLimit = (value) => {
    if (!Number.isInteger(value))
        return DEFAULT_LIMIT;
    return Math.min(exports.MAX_LIMIT, Math.max(1, value));
};
exports.clampLimit = clampLimit;
const emptyCounts = () => ({ pass: 0, partial: 0, fail: 0, error: 0 });
// Membership via a Set, not `score in counts`: `in` walks the prototype chain,
// so a corrupt stored score like "constructor" would match and add to a
// function instead of falling through to `error`.
const KNOWN_SCORES = new Set(['pass', 'partial', 'fail', 'error']);
const countScores = (results) => {
    const counts = emptyCounts();
    for (const result of results) {
        const score = result.score;
        if (KNOWN_SCORES.has(score))
            counts[score] += 1;
        else
            counts.error += 1;
    }
    return counts;
};
const toSummary = (doc) => {
    var _a;
    return ({
        id: String(doc._id),
        startedAt: doc.startedAt.toISOString(),
        finishedAt: doc.finishedAt ? doc.finishedAt.toISOString() : null,
        status: doc.status,
        models: doc.models,
        counts: countScores(doc.results),
        total: doc.results.length,
        error: (_a = doc.error) !== null && _a !== void 0 ? _a : null,
    });
};
const listEvalRuns = (limit) => __awaiter(void 0, void 0, void 0, function* () {
    const docs = yield EvalRunRecord_1.EvalRunRecord.find().sort({ startedAt: -1 }).limit((0, exports.clampLimit)(limit)).exec();
    return docs.map(toSummary);
});
exports.listEvalRuns = listEvalRuns;
const getEvalRun = (id) => __awaiter(void 0, void 0, void 0, function* () {
    const doc = yield EvalRunRecord_1.EvalRunRecord.findById(id).exec();
    if (!doc)
        return null;
    const results = doc.results.map((result) => ({
        caseId: result.caseId,
        model: result.model,
        provider: result.provider,
        score: result.score,
        report: result.report,
    }));
    return Object.assign(Object.assign({}, toSummary(doc)), { results });
});
exports.getEvalRun = getEvalRun;
