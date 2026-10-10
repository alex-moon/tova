"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Entity = exports.bumpConfidence = exports.HIGH_CONFIDENCE = exports.LOW_CONFIDENCE = void 0;
const mongoose_1 = __importDefault(require("mongoose"));
/*
 * Per-user entity graph nodes (issue #138). Deliberately loose schema while
 * the ontology (plan-138) is still being settled: `kind`, `attrs` and the
 * edge vocabulary can evolve without migrations. Identity is exact-match on
 * {(userId, normalizedName, kind)}; anything fuzzier is out of scope.
 */
const sourceRefSchema = new mongoose_1.default.Schema({
    sessionId: {
        type: mongoose_1.default.Schema.Types.ObjectId,
        ref: 'Session',
        required: true,
    },
    messageId: {
        type: mongoose_1.default.Schema.Types.ObjectId,
        ref: 'Message',
    },
});
/*
 * Plan-138 task 7 confidence model ("what fires together wires together"):
 * every node starts LOW; each confirmed cross-chat mention bumps it by a
 * saturating step so a node needs several mentions to reach HIGH, and only
 * HIGH nodes are eligible for prompt injection. Both values are guesses
 * pending real extraction data — named here, not env-configured, so flipping
 * the numbers is a one-commit change.
 */
exports.LOW_CONFIDENCE = 0.25;
exports.HIGH_CONFIDENCE = 0.75;
// Saturation step: 1 − (1 − c) · 0.8, i.e. diminishing returns; never exceeds 1.
const bumpConfidence = (confidence) => confidence + 0.2 * (1 - confidence);
exports.bumpConfidence = bumpConfidence;
const entitySchema = new mongoose_1.default.Schema({
    userId: {
        type: mongoose_1.default.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },
    name: {
        type: String,
        required: true,
    },
    // Lowercase, whitespace-collapsed `name` — the exact-match identity key.
    normalizedName: {
        type: String,
        required: true,
    },
    // Loose ontology (plan-138 open question): person, place, organization,
    // project, task, event, commitment, preference to start.
    kind: {
        type: String,
        required: true,
    },
    summary: {
        type: String,
    },
    // Bag of loose facts (e.g. { city: 'Mumbai' }); may stay absent.
    attrs: {
        type: mongoose_1.default.Schema.Types.Mixed,
    },
    mentionCount: {
        type: Number,
        default: 1,
    },
    confidence: {
        type: Number,
        default: exports.LOW_CONFIDENCE,
    },
    salience: {
        type: String,
        enum: ['low', 'high'],
        default: 'low',
    },
    lastMentionedAt: {
        type: Date,
        default: Date.now,
    },
    // Where each mention came from, so every inferred fact stays auditable
    // (plan decision 5: human-readable observability first).
    sourceRefs: {
        type: [sourceRefSchema],
        default: [],
    },
});
entitySchema.index({ userId: 1, normalizedName: 1, kind: 1 }, { unique: true });
entitySchema.index({ userId: 1, lastMentionedAt: -1 });
exports.Entity = mongoose_1.default.model('Entity', entitySchema);
