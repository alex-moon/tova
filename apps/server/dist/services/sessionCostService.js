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
exports.sessionCostBreakdown = void 0;
const Message_1 = require("../models/Message");
const Session_1 = require("../models/Session");
const traceStatsCost_1 = require("./traceStatsCost");
const DEFAULT_LIMIT = 50;
const finiteOr = (value) => typeof value === 'number' && Number.isFinite(value) ? value : 0;
const sessionCostBreakdown = (options) => __awaiter(void 0, void 0, void 0, function* () {
    var _a, _b, _c, _d;
    const limit = (_a = options.limit) !== null && _a !== void 0 ? _a : DEFAULT_LIMIT;
    // Only assistant messages can carry token usage, but message-in counts come
    // from user rows, so the grouping covers both roles. `usageCount` counts
    // assistant rows that actually carry usage, so a model whose only turns
    // predate #224 is not priced at $0 (unknown ≠ free).
    const grouped = yield Message_1.Message.aggregate([
        { $match: { timestamp: { $gte: options.since } } },
        {
            $group: {
                _id: { sessionId: '$sessionId', modelName: '$modelName', provider: '$provider' },
                messagesIn: { $sum: { $cond: [{ $eq: ['$role', 'user'] }, 1, 0] } },
                messagesOut: { $sum: { $cond: [{ $eq: ['$role', 'assistant'] }, 1, 0] } },
                inputTokens: { $sum: { $ifNull: ['$usage.inputTokens', 0] } },
                outputTokens: { $sum: { $ifNull: ['$usage.outputTokens', 0] } },
                totalTokens: { $sum: { $ifNull: ['$usage.totalTokens', 0] } },
                usageCount: {
                    $sum: {
                        $cond: [
                            {
                                $or: [
                                    { $isNumber: '$usage.inputTokens' },
                                    { $isNumber: '$usage.outputTokens' },
                                    { $isNumber: '$usage.totalTokens' },
                                ],
                            },
                            1,
                            0,
                        ],
                    },
                },
                lastActivity: { $max: '$timestamp' },
            },
        },
    ]);
    // One roster read prices every group: the index resolves `(model, provider)`
    // with a model-only fallback for legacy turns (same resolver as the LangSmith
    // rollup).
    const priceIndex = yield (0, traceStatsCost_1.loadPriceIndex)();
    const bySession = new Map();
    for (const row of grouped) {
        const sessionId = row._id.sessionId != null ? String(row._id.sessionId) : null;
        if (!sessionId)
            continue;
        const acc = (_b = bySession.get(sessionId)) !== null && _b !== void 0 ? _b : {
            messagesIn: 0,
            messagesOut: 0,
            inputTokens: 0,
            outputTokens: 0,
            cost: 0,
            anyPriced: false,
            lastActivity: 0,
        };
        const ts = row.lastActivity ? new Date(row.lastActivity).getTime() : 0;
        if (ts > acc.lastActivity)
            acc.lastActivity = ts;
        acc.messagesIn += row.messagesIn;
        acc.messagesOut += row.messagesOut;
        let inputTokens = finiteOr(row.inputTokens);
        const outputTokens = finiteOr(row.outputTokens);
        // Fallback (plan OC-7): a provider that reported only a total with no
        // split must not be silently priced at `$0`. Treat the total as input so
        // the turn still contributes an estimate.
        if (inputTokens === 0 && outputTokens === 0) {
            inputTokens = finiteOr(row.totalTokens);
        }
        acc.inputTokens += inputTokens;
        acc.outputTokens += outputTokens;
        // A (session, model) group with no logged usage (all turns before #224)
        // has no known spend: do NOT price it at `$0`, which would misreport
        // "unlogged" as "free". Only groups that carry token data contribute cost.
        const cost = row.usageCount > 0
            ? (0, traceStatsCost_1.estimateCostUsd)(inputTokens, outputTokens, (0, traceStatsCost_1.priceFor)(priceIndex, (_c = row._id.modelName) !== null && _c !== void 0 ? _c : '', (_d = row._id.provider) !== null && _d !== void 0 ? _d : undefined))
            : null;
        if (cost !== null) {
            acc.anyPriced = true;
            acc.cost += cost;
        }
        bySession.set(sessionId, acc);
    }
    const sessionIds = [...bySession.keys()];
    const sessions = sessionIds.length > 0
        ? yield Session_1.Session.find({ _id: { $in: sessionIds } })
            .select({ title: 1 })
            .lean()
        : [];
    const titleById = new Map(sessions.map((s) => { var _a; return [String(s._id), (_a = s.title) !== null && _a !== void 0 ? _a : 'Untitled']; }));
    const result = sessionIds
        .map((sessionId) => {
        var _a;
        const acc = bySession.get(sessionId);
        return {
            sessionId,
            title: (_a = titleById.get(sessionId)) !== null && _a !== void 0 ? _a : 'Untitled',
            messagesIn: acc.messagesIn,
            messagesOut: acc.messagesOut,
            inputTokens: acc.inputTokens,
            outputTokens: acc.outputTokens,
            estimatedCostUsd: acc.anyPriced ? acc.cost : null,
            lastActivityAt: new Date(acc.lastActivity).toISOString(),
        };
    })
        .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
        .slice(0, limit);
    let anyPricedTotal = false;
    let costTotal = 0;
    let messagesIn = 0;
    let messagesOut = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    for (const row of result) {
        messagesIn += row.messagesIn;
        messagesOut += row.messagesOut;
        inputTokens += row.inputTokens;
        outputTokens += row.outputTokens;
        if (row.estimatedCostUsd !== null) {
            anyPricedTotal = true;
            costTotal += row.estimatedCostUsd;
        }
    }
    return {
        since: options.since.toISOString(),
        sessions: result,
        totals: {
            sessions: result.length,
            messagesIn,
            messagesOut,
            inputTokens,
            outputTokens,
            estimatedCostUsd: anyPricedTotal ? costTotal : null,
        },
    };
});
exports.sessionCostBreakdown = sessionCostBreakdown;
