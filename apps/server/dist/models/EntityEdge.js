"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.EntityEdge = void 0;
const mongoose_1 = __importDefault(require("mongoose"));
/*
 * Typed edge between two entity nodes of one user (issue #138). One doc per
 * link; `kind` stays free-form until the ontology settles (plan-138).
 */
const entityEdgeSchema = new mongoose_1.default.Schema({
    userId: {
        type: mongoose_1.default.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },
    fromEntityId: {
        type: mongoose_1.default.Schema.Types.ObjectId,
        ref: 'Entity',
        required: true,
    },
    toEntityId: {
        type: mongoose_1.default.Schema.Types.ObjectId,
        ref: 'Entity',
        required: true,
    },
    kind: {
        type: String,
        required: true,
    },
    // Free-text gloss of why the link exists, straight from the extracting LLM.
    summary: {
        type: String,
    },
    sourceRefs: {
        type: [
            {
                _id: false,
                sessionId: {
                    type: mongoose_1.default.Schema.Types.ObjectId,
                    ref: 'Session',
                    required: true,
                },
                messageId: {
                    type: mongoose_1.default.Schema.Types.ObjectId,
                    ref: 'Message',
                },
            },
        ],
        default: [],
    },
});
// Identity guard: the same typed link between the same two nodes should be
// one row, not one per mention.
entityEdgeSchema.index({ userId: 1, fromEntityId: 1, toEntityId: 1, kind: 1 }, { unique: true });
entityEdgeSchema.index({ userId: 1, fromEntityId: 1 });
exports.EntityEdge = mongoose_1.default.model('EntityEdge', entityEdgeSchema);
