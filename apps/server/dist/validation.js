"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mcpServerCreateSchema = exports.assetBulkConfirmSchema = exports.assetBulkPresignSchema = exports.MAX_BULK_FILES = exports.assetBulkDeleteQuerySchema = exports.assetBulkDownloadQuerySchema = exports.zdrHistorySchema = exports.zdrHistoryEntrySchema = exports.assetPresignSchema = exports.feedbackValueSchema = exports.factoryResetSchema = exports.FACTORY_RESET_CONFIRM = exports.profilePatchSchema = exports.createPatSchema = exports.loginSchema = exports.registerSchema = void 0;
const zod_1 = require("zod");
const assetLimits_1 = require("./services/assetLimits");
exports.registerSchema = zod_1.z.object({
    email: zod_1.z.email({ message: 'Email must be a valid email address' }).min(1, {
        message: 'Email is required',
    }),
    password: zod_1.z
        .string({ message: 'Password is required' })
        .min(8, { message: 'Password must be at least 8 characters' }),
});
exports.loginSchema = zod_1.z.object({
    email: zod_1.z.string({ message: 'Email is required' }).min(1, { message: 'Email is required' }),
    password: zod_1.z
        .string({ message: 'Password is required' })
        .min(1, { message: 'Password is required' }),
});
// POST /api/admin/pats body (#184): display name for the token in the
// Access tab.
exports.createPatSchema = zod_1.z.object({
    name: zod_1.z
        .string({ message: 'Name is required' })
        .min(1, { message: 'Name is required' })
        .max(100, { message: 'Name must be at most 100 characters' }),
});
// PATCH /api/profile body (issue #35). Strict on purpose: unknown keys
// (name, avatarUrl, email, role…) are a 400, not silently dropped — a client
// bug must not pretend success while losing data. Telegram-style: absent keys
// are untouched; present keys set the field (trimmed-empty string clears).
//
// preferredName (PR #46 review): 20 chars max, and the charset is tightened
// server-side in routes/profile.ts — only alphanumerics, spaces and
// name-typical punctuation (, ' - , :) survive; anything JSON/XML-ish ({ } < > " ;) is stripped.
exports.profilePatchSchema = zod_1.z.strictObject({
    preferredName: zod_1.z
        .string({ message: 'preferredName must be a string' })
        .max(20, { message: 'preferredName must be 20 characters or fewer' })
        .optional(),
    customInstructions: zod_1.z
        .string({ message: 'customInstructions must be a string' })
        .max(4000, { message: 'customInstructions must be 4000 characters or fewer' })
        .optional(),
    theme: zod_1.z.enum(['light', 'dark'], { message: 'theme must be "light" or "dark"' }).optional(),
    // Startup-chat preference (issue #96): what the chat view shows on first
    // open — the most recent chat (product default, also what null means) or a
    // blank new chat.
    startupChat: zod_1.z
        .enum(['recent', 'new'], {
        message: 'startupChat must be "recent" or "new"',
    })
        .optional(),
    // Zero-data-retention preference (issue #116): opts the account out of all
    // chat persistence. Boolean-only and forward-looking — enabling it does not
    // delete anything (issue #143 removed the first-enable auto-purge); wiping
    // existing data is now the explicit /factory-reset route below.
    zdr: zod_1.z.boolean({ message: 'zdr must be a boolean' }).optional(),
    // 'Incognito by default' (issue #144): new chats start incognito when set.
    // Reads and writes the same settings.zdr storage slot — single source of
    // truth; `zdr` is its legacy alias kept for the frozen #116 test surface
    // and the existing client contract. Rename both together whenever the
    // internal rename happens.
    incognitoByDefault: zod_1.z.boolean({ message: 'incognitoByDefault must be a boolean' }).optional(),
    // Granular delete-confirmation prefs (issue #59). Strict sub-object: an
    // unknown delete target is a 400, not a silently dropped key.
    confirmDeletes: zod_1.z
        .strictObject({
        chat: zod_1.z.boolean().optional(),
        file: zod_1.z.boolean().optional(),
    })
        .optional(),
});
// Factory reset (issue #143): the exact confirmation string a user must type
// to unlock the route. A fixed product literal, not user data — copy lives on
// the client, verification is exact-match here.
exports.FACTORY_RESET_CONFIRM = 'RESET';
exports.factoryResetSchema = zod_1.z.strictObject({
    confirm: zod_1.z.literal(exports.FACTORY_RESET_CONFIRM, {
        message: `Type ${exports.FACTORY_RESET_CONFIRM} to confirm the factory reset`,
    }),
});
exports.feedbackValueSchema = zod_1.z.object({
    value: zod_1.z.enum(['up', 'down'], { message: 'value must be "up" or "down"' }),
});
// Asset uploads (issue #34): the browser sends the file directly to Spaces,
// so the server only validates metadata at presign time. Size/type caps are
// enforced again here (presign) and reconciled against the real object at
// confirm time.
exports.assetPresignSchema = zod_1.z.object({
    filename: zod_1.z
        .string({ message: 'Filename is required' })
        .min(1, { message: 'Filename is required' })
        .max(255, { message: 'Filename must be at most 255 characters' }),
    contentType: zod_1.z
        .string({ message: 'Content type is required' })
        .min(1, { message: 'Content type is required' }),
    size: zod_1.z
        .number({ message: 'Size is required' })
        .int({ message: 'Size must be an integer' })
        .positive({ message: 'Size must be positive' }),
    // Upload origin (issue #116): the chat composer tags its uploads so a ZDR
    // user's chat attachments can be kept out of long-term storage, while
    // Assets-page uploads (no scope) live on until deleted. The server still
    // decides from the effective per-chat incognito flag (#144) — the tag alone
    // never changes storage behavior for other users.
    scope: zod_1.z.enum(['chat'], { message: 'scope must be "chat"' }).optional(),
    // Per-chat incognito inputs (#144). For an existing chat the composer sends
    // `chatId` and the stored session flag decides; for a brand-new incognito
    // chat (the upload precedes session creation) the client sends `zdr`
    // matching the composer toggle, and absent both the profile's 'incognito by
    // default' decides. Storage name stays `zdr` per the plan's minimal-churn
    // variant; ownership of `chatId` is checked in the route (404 on foreign).
    chatId: zod_1.z.string({ message: 'chatId must be a string' }).optional(),
    zdr: zod_1.z.boolean({ message: 'zdr must be a boolean' }).optional(),
});
// ZDR chats (issue #116) are stateless per turn: with persistence off, the
// client replays the conversation so far and the server keeps nothing. Bound
// the replay hard — recent turns only, and the same 4000-char cap the profile
// custom-instructions field uses.
exports.zdrHistoryEntrySchema = zod_1.z.object({
    role: zod_1.z.enum(['user', 'assistant'], { message: 'history role must be user or assistant' }),
    content: zod_1.z
        .string({ message: 'history content must be a string' })
        .min(1, { message: 'history content must not be empty' })
        .max(4000, { message: 'history content must be 4000 characters or fewer' }),
});
exports.zdrHistorySchema = zod_1.z
    .array(exports.zdrHistoryEntrySchema, { message: 'history must be an array' })
    .max(20, { message: 'history may contain at most 20 entries' });
// GET /api/assets/bulk-download query (issue #69). Express 5's default query
// parser returns an array for repeated `?id=` params but a scalar string for
// a single one — preprocess both into an array. Explicit id list only for
// v1; 50 entries is the per-archive cap.
exports.assetBulkDownloadQuerySchema = zod_1.z.object({
    id: zod_1.z.preprocess((value) => (Array.isArray(value) ? value : [value]), zod_1.z
        .array(zod_1.z.string({ message: 'id is required' }).min(1, { message: 'id is required' }), {
        message: 'id is required',
    })
        .min(1, { message: 'At least one asset id is required' })
        .max(50, { message: 'At most 50 assets can be downloaded at once' })),
});
// DELETE /api/assets/bulk-delete shares the repeated `?id=` contract with
// bulk download; messages are worded neutrally so both routes can use it.
exports.assetBulkDeleteQuerySchema = zod_1.z.object({
    id: zod_1.z.preprocess((value) => (Array.isArray(value) ? value : [value]), zod_1.z
        .array(zod_1.z.string({ message: 'id is required' }).min(1, { message: 'id is required' }), {
        message: 'id is required',
    })
        .min(1, { message: 'At least one asset id is required' })
        .max(50, { message: 'At most 50 assets can be deleted at once' })),
});
// Bulk upload (issue #68): one batched presign/confirm round-trip for up to
// MAX_BULK_FILES files, each item shaped exactly like a single-file presign.
// Hard rule from the ticket: files arrive via N normal singleton uploads and
// the direct-to-Spaces PUT flow — zip is never an accepted upload format at
// any layer (ALLOWED_CONTENT_TYPES in services/assetLimits.ts excludes it),
// and uploaded archives are never read or unzipped anywhere.
//
// These schemas shape the batch; per-item content-type/size policy lives in
// the routes (validation.ts knows shapes, routes know policy). The total
// declared size cap is a batch-shape guard here: one HTTP request must not
// carry an unbounded array of sizes.
exports.MAX_BULK_FILES = 20;
exports.assetBulkPresignSchema = zod_1.z
    .array(exports.assetPresignSchema, { message: 'Bulk upload payload must be an array of files' })
    .min(1, { message: 'Bulk upload must include at least one file' })
    .max(exports.MAX_BULK_FILES, {
    message: `Bulk upload is limited to ${exports.MAX_BULK_FILES} files per batch`,
})
    .refine((items) => items.reduce((sum, item) => sum + item.size, 0) <= assetLimits_1.MAX_BULK_TOTAL_SIZE, {
    message: 'Combined file size exceeds the bulk upload limit',
});
exports.assetBulkConfirmSchema = zod_1.z
    .array(zod_1.z.object({
    assetId: zod_1.z
        .string({ message: 'Asset id is required' })
        .min(1, { message: 'Asset id is required' }),
}), { message: 'Bulk confirm payload must be an array of asset ids' })
    .min(1, { message: 'Bulk confirm must include at least one asset' })
    .max(exports.MAX_BULK_FILES, {
    message: `Bulk confirm is limited to ${exports.MAX_BULK_FILES} assets per batch`,
});
// POST /api/mcp-servers body (issue #36). Personal MCP servers only: the
// route is authenticated and always writes scope:'user' owned by the caller.
// https-only URLs keep the outbound connect surface (SSRF) off plain HTTP;
// auth is submitted as a raw token (issue #80) — the server wraps it in
// `Authorization: Bearer <token>` and stores that single header encrypted.
exports.mcpServerCreateSchema = zod_1.z.strictObject({
    name: zod_1.z
        .string({ message: 'Name is required' })
        .min(1, { message: 'Name is required' })
        .max(60, { message: 'Name must be 60 characters or fewer' }),
    url: zod_1.z
        .string({ message: 'URL is required' })
        .trim()
        .url({ message: 'URL must be a valid URL' })
        .refine((value) => value.startsWith('https://'), {
        message: 'URL must be an https URL',
    }),
    authToken: zod_1.z
        .string({ message: 'authToken must be a string' })
        .max(4000, { message: 'authToken is too long' })
        .optional(),
});
