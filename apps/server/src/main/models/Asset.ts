import mongoose from 'mongoose';

const assetSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
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
    // Issue #66: origin flag ("did Tova make it?"). Legacy docs predate this
    // field; Mongoose applies the default at read time, so no backfill is
    // needed. This is a separate, boolean-ish axis from `provenance` below.
    // #340 adds 'system-side': Tova-made material for the AGENT's own reading
    // (a scraped web page saved so read_file can page through it) — never
    // shown in the library, not editable, no Spaces object, swept on a TTL.
    origin: {
      type: String,
      enum: ['user-upload', 'system-generated', 'system-side'],
      default: 'user-upload',
    },
    // #325: current version number of the file's content. 1 until the first
    // edit; every `edit_file` write / restore bumps it and snapshots both the
    // pre-write and new content into `AssetVersion`. Legacy docs read as 1 via
    // the default. Only `system-generated` files are ever edited, so this stays
    // 1 for uploads.
    version: {
      type: Number,
      default: 1,
    },
    // Issue #252 (epic #251): where the file came from — the vocabulary
    // later slices (task artifacts, cross-chat memory) write into. Deliberately
    // ODDBALL-FREE and ADDITIVE: it does not touch the scalar `origin` above.
    // Absence policy: `provenance` is absent (undefined) on legacy rows and is
    // never defaulted or faked — absent means "unknown", never "no source"
    // (same rule as roster pricing, #199: missing ≠ free). There is no
    // `default` here by design; a read-time `{}` would serialise to a
    // non-null "unknown-but-present" value and break that invariant.
    // `_id: false`: provenance is a singleton value object, so a per-row
    // subdoc id is pure noise (cf. the `units` subdoc above).
    provenance: {
      required: false,
      type: new mongoose.Schema(
        {
          kind: {
            type: String,
            enum: ['upload', 'chat', 'task'],
            required: true,
          },
          sessionId: { type: String },
          taskId: { type: String },
          messageId: { type: String },
        },
        { _id: false },
      ),
    },
    // Populated only when status is 'failed' (HEAD miss, oversize, stale).
    failureReason: {
      type: String,
      default: null,
    },
    // #340: agent-side rows (origin 'system-side') only. The TTL index below
    // expires a document at exactly this moment; a document without the field
    // (every user upload and generated file) is never TTL-eligible.
    expiresAt: { type: Date },
    // #340: the URL a system-side row was scraped from — the cache key that
    // lets a follow-up reuse a fresh copy instead of paying for a re-scrape.
    sourceUrl: { type: String, default: null },
    // Zero-data retention (issue #116): chat-composer uploads from a ZDR user
    // are throwaway — the bytes and row are removed as soon as the turn that
    // used them completes. Assets-page uploads are never ephemeral, so a
    // saved library file can still be attached to a ZDR chat without being
    // deleted.
    ephemeral: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  },
);

// Cursor-paged per-user listing (`{ userId, _id }` ascending).
assetSchema.index({ userId: 1, _id: 1 });

// Issue #67: future search queries over converted markdown; not exercised by
// this ticket's read paths.
assetSchema.index({ markdownExtracted: 1 });

// #340: native TTL for agent-side assets. expireAfterSeconds: 0 expires a
// document at exactly its own `expiresAt` value; only system-side rows carry
// that field, so nothing else is ever eligible. The TTL monitor runs about
// every 60s, so deletion lands within a minute of the cutoff, and the remove
// is a bare collection delete (no Mongoose middleware) — complete by design,
// because system-side rows have no Spaces object to outlive them.
assetSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type AssetDocument = mongoose.HydratedDocument<mongoose.InferSchemaType<typeof assetSchema>>;

// Issue #252: the provenance vocabulary, re-exported so views/tools/client
// types share exactly one shape. Optional fields are omitted, never faked.
export interface AssetProvenance {
  kind: 'upload' | 'chat' | 'task';
  sessionId?: string;
  taskId?: string;
  messageId?: string;
}

export const Asset = mongoose.model('Asset', assetSchema);
