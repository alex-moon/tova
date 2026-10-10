"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Asset = void 0;
const mongoose_1 = __importDefault(require("mongoose"));
const assetSchema = new mongoose_1.default.Schema({
    userId: {
        type: mongoose_1.default.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },
    filename: {
        type: String,
        required: true,
    },
    // Spaces object key: `<userId>/<assetId>/<filename>`
    key: {
        type: String,
        required: true,
    },
    contentType: {
        type: String,
        required: true,
    },
    size: {
        type: Number,
        required: true,
    },
    // Light extraction result (issue #34): deterministic UTF-8 decode for
    // txt/md/csv, null ("no text extracted") for everything else.
    textExtracted: {
        type: String,
        default: null,
    },
    // Markdown conversion (issue #67): document uploads (pdf, docx, html)
    // get converted by the asset-job worker and the markdown is stored here,
    // capped at MAX_MARKDOWN_CHARS. Distinct from textExtracted so the fast
    // extraction path (txt/md/csv) keeps its semantics; `markdownStatus`
    // tracks the conversion lifecycle so the library UI can show pending /
    // ready / failed states without ever shipping the markdown text itself
    // to the client.
    markdownExtracted: {
        type: String,
        default: null,
    },
    markdownStatus: {
        type: String,
        enum: ['none', 'pending', 'ready', 'failed'],
        default: 'none',
    },
    markdownFailureReason: {
        type: String,
        default: null,
    },
    // Image thumbnail (issue #208): the /assets viewer must not load a large
    // original into the detail pane, so the asset-job worker derives one
    // bounded thumbnail object and stores it under `thumbnailKey` alongside
    // the original. Mirrors the markdown lifecycle (`thumbnailStatus`) and it
    // is never user-visible text.
    thumbnailKey: {
        type: String,
        default: null,
    },
    thumbnailStatus: {
        type: String,
        enum: ['none', 'pending', 'ready', 'failed'],
        default: 'none',
    },
    // Issue #159: per-unit extracted text (one unit per PDF page, per
    // top-level section for md/html, whole doc otherwise) so the agent can
    // walk long documents unit by unit. Additive to `markdownExtracted`
    // (units slice the already-capped conversion output); invisible to the
    // user. `select: false` keeps the default query light like the other
    // heavy text fields; readers that need units must select them.
    units: {
        select: false,
        // `_id: false`: units are derived slices re-generated on every job run,
        // so per-unit ObjectIds are pure noise/storage.
        type: [
            {
                _id: false,
                index: { type: Number, required: true },
                label: { type: String, required: true },
                text: { type: String, required: true },
            },
        ],
        default: [],
    },
    status: {
        type: String,
        enum: ['pending', 'ready', 'failed'],
        default: 'pending',
    },
    // Issue #66: provenance. Legacy docs predate this field; Mongoose
    // applies the default at read time, so no backfill is needed.
    origin: {
        type: String,
        enum: ['user-upload', 'system-generated'],
        default: 'user-upload',
    },
    // Populated only when status is 'failed' (HEAD miss, oversize, stale).
    failureReason: {
        type: String,
        default: null,
    },
    // Zero-data retention (issue #116): chat-composer uploads from a ZDR user
    // are throwaway — the bytes and row are removed as soon as the turn that
    // used them completes. Assets-page uploads are never ephemeral, so a
    // saved library file can still be attached to a ZDR chat without being
    // deleted.
    ephemeral: {
        type: Boolean,
        default: false,
    },
}, {
    timestamps: true,
});
// Cursor-paged per-user listing (`{ userId, _id }` ascending).
assetSchema.index({ userId: 1, _id: 1 });
// Issue #67: future search queries over converted markdown; not exercised by
// this ticket's read paths.
assetSchema.index({ markdownExtracted: 1 });
exports.Asset = mongoose_1.default.model('Asset', assetSchema);
