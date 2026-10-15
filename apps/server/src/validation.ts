import { z } from 'zod';
import { MAX_BULK_TOTAL_SIZE } from './services/assetLimits';

// Node's canonical IANA zone list (418 entries) plus the UTC/GMT aliases a
// browser may report that the list omits. Computed once at module load. The
// list API is typed only from ES2022 lib onward — this target is older, hence
// the local guard; an engine without it degrades to a shape check (and
// prompt-side rendering still try/catches an unknown zone back to UTC).
const supportedZones: string[] =
  (Intl as { supportedValuesOf?: (kind: 'timeZone') => string[] }).supportedValuesOf?.(
    'timeZone',
  ) ?? [];
const KNOWN_TIMEZONES = new Set<string>([...supportedZones, 'UTC', 'Etc/UTC', 'Etc/GMT', 'GMT']);
const IANA_ZONE_SHAPE = /^[A-Za-z]+(\/[A-Za-z0-9_+-]+)+$/;

export const isKnownTimezone = (zone: string): boolean =>
  supportedZones.length > 0 ? KNOWN_TIMEZONES.has(zone) : IANA_ZONE_SHAPE.test(zone);

export const registerSchema = z.object({
  email: z.email({ message: 'Email must be a valid email address' }).min(1, {
    message: 'Email is required',
  }),
  password: z
    .string({ message: 'Password is required' })
    .min(8, { message: 'Password must be at least 8 characters' }),
});

export const loginSchema = z.object({
  email: z.string({ message: 'Email is required' }).min(1, { message: 'Email is required' }),
  password: z
    .string({ message: 'Password is required' })
    .min(1, { message: 'Password is required' }),
});

// POST /api/admin/pats body (#184): display name for the token in the
// Access tab.
export const createPatSchema = z.object({
  name: z
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
export const profilePatchSchema = z.strictObject({
  preferredName: z
    .string({ message: 'preferredName must be a string' })
    .max(20, { message: 'preferredName must be 20 characters or fewer' })
    .optional(),
  customInstructions: z
    .string({ message: 'customInstructions must be a string' })
    .max(4000, { message: 'customInstructions must be 4000 characters or fewer' })
    .optional(),
  theme: z.enum(['light', 'dark'], { message: 'theme must be "light" or "dark"' }).optional(),
  // Startup-chat preference (issue #96): what the chat view shows on first
  // open — the most recent chat (product default, also what null means) or a
  // blank new chat.
  startupChat: z
    .enum(['recent', 'new'], {
      message: 'startupChat must be "recent" or "new"',
    })
    .optional(),
  // Zero-data-retention preference (issue #116): opts the account out of all
  // chat persistence. Boolean-only and forward-looking — enabling it does not
  // delete anything (issue #143 removed the first-enable auto-purge); wiping
  // existing data is now the explicit /factory-reset route below.
  zdr: z.boolean({ message: 'zdr must be a boolean' }).optional(),
  // 'Incognito by default' (issue #144): new chats start incognito when set.
  // Reads and writes the same settings.zdr storage slot — single source of
  // truth; `zdr` is its legacy alias kept for the frozen #116 test surface
  // and the existing client contract. Rename both together whenever the
  // internal rename happens.
  incognitoByDefault: z.boolean({ message: 'incognitoByDefault must be a boolean' }).optional(),
  // Granular delete-confirmation prefs (issue #59). Strict sub-object: an
  // unknown delete target is a 400, not a silently dropped key.
  confirmDeletes: z
    .strictObject({
      chat: z.boolean().optional(),
      file: z.boolean().optional(),
    })
    .optional(),
  // Browser IANA timezone (#261): validated against the platform's own zone
  // list so the prompt's `Intl.DateTimeFormat` call cannot throw on a garbage
  // string. Aliases browsers legitimately report but the list omits (UTC/GMT)
  // are accepted explicitly.
  timezone: z
    .string({ message: 'timezone must be a string' })
    .max(64, { message: 'timezone must be 64 characters or fewer' })
    .refine(isKnownTimezone, { message: 'timezone must be a valid IANA timezone' })
    .optional(),
});

// Factory reset (issue #143): the exact confirmation string a user must type
// to unlock the route. A fixed product literal, not user data — copy lives on
// the client, verification is exact-match here.
export const FACTORY_RESET_CONFIRM = 'RESET';

export const factoryResetSchema = z.strictObject({
  confirm: z.literal(FACTORY_RESET_CONFIRM, {
    message: `Type ${FACTORY_RESET_CONFIRM} to confirm the factory reset`,
  }),
});

export const feedbackValueSchema = z.object({
  value: z.enum(['up', 'down'], { message: 'value must be "up" or "down"' }),
});

// Task creation (#254 routes slice, D15): a direct-origin task is first-class
// (D3), so `instruction` is optional and `origin` is an optional thin
// reference. A task's *scope* is the workspace, not a chat (D3) — a chat-origin
// task carries only the session id, never a Message FK.
export const taskCreateSchema = z.strictObject({
  instruction: z
    .string({ message: 'instruction must be a string' })
    .max(4000, { message: 'instruction must be 4000 characters or fewer' })
    .optional(),
  origin: z
    .strictObject({
      kind: z.enum(['chat', 'direct'], { message: 'origin.kind must be "chat" or "direct"' }),
      sessionId: z.string({ message: 'origin.sessionId must be a string' }).optional(),
    })
    .optional(),
});

// POST /api/tasks/:id/instruction (D14): a steering turn / resume. Non-empty —
// an empty steering turn has nothing to say.
export const taskInstructionSchema = z.strictObject({
  instruction: z
    .string({ message: 'instruction is required' })
    .min(1, { message: 'instruction must not be empty' })
    .max(4000, { message: 'instruction must be 4000 characters or fewer' }),
});

// Asset uploads (issue #34): the browser sends the file directly to Spaces,
// so the server only validates metadata at presign time. Size/type caps are
// enforced again here (presign) and reconciled against the real object at
// confirm time.
export const assetPresignSchema = z.object({
  filename: z
    .string({ message: 'Filename is required' })
    .min(1, { message: 'Filename is required' })
    .max(255, { message: 'Filename must be at most 255 characters' }),
  contentType: z
    .string({ message: 'Content type is required' })
    .min(1, { message: 'Content type is required' }),
  size: z
    .number({ message: 'Size is required' })
    .int({ message: 'Size must be an integer' })
    .positive({ message: 'Size must be positive' }),
  // Upload origin (issue #116): the chat composer tags its uploads so a ZDR
  // user's chat attachments can be kept out of long-term storage, while
  // Assets-page uploads (no scope) live on until deleted. The server still
  // decides from the effective per-chat incognito flag (#144) — the tag alone
  // never changes storage behavior for other users.
  scope: z.enum(['chat'], { message: 'scope must be "chat"' }).optional(),
  // Per-chat incognito inputs (#144). For an existing chat the composer sends
  // `chatId` and the stored session flag decides; for a brand-new incognito
  // chat (the upload precedes session creation) the client sends `zdr`
  // matching the composer toggle, and absent both the profile's 'incognito by
  // default' decides. Storage name stays `zdr` per the plan's minimal-churn
  // variant; ownership of `chatId` is checked in the route (404 on foreign).
  chatId: z.string({ message: 'chatId must be a string' }).optional(),
  zdr: z.boolean({ message: 'zdr must be a boolean' }).optional(),
});

// ZDR chats (issue #116) are stateless per turn: with persistence off, the
// client replays the conversation so far and the server keeps nothing. Bound
// the replay hard — recent turns only, and the same 4000-char cap the profile
// custom-instructions field uses.
export const zdrHistoryEntrySchema = z.object({
  role: z.enum(['user', 'assistant'], { message: 'history role must be user or assistant' }),
  content: z
    .string({ message: 'history content must be a string' })
    .min(1, { message: 'history content must not be empty' })
    .max(4000, { message: 'history content must be 4000 characters or fewer' }),
});

export const zdrHistorySchema = z
  .array(zdrHistoryEntrySchema, { message: 'history must be an array' })
  .max(20, { message: 'history may contain at most 20 entries' });

// GET /api/assets/bulk-download query (issue #69). Express 5's default query
// parser returns an array for repeated `?id=` params but a scalar string for
// a single one — preprocess both into an array. Explicit id list only for
// v1; 50 entries is the per-archive cap.
export const assetBulkDownloadQuerySchema = z.object({
  id: z.preprocess(
    (value) => (Array.isArray(value) ? value : [value]),
    z
      .array(z.string({ message: 'id is required' }).min(1, { message: 'id is required' }), {
        message: 'id is required',
      })
      .min(1, { message: 'At least one asset id is required' })
      .max(50, { message: 'At most 50 assets can be downloaded at once' }),
  ),
});

// DELETE /api/assets/bulk-delete shares the repeated `?id=` contract with
// bulk download; messages are worded neutrally so both routes can use it.
export const assetBulkDeleteQuerySchema = z.object({
  id: z.preprocess(
    (value) => (Array.isArray(value) ? value : [value]),
    z
      .array(z.string({ message: 'id is required' }).min(1, { message: 'id is required' }), {
        message: 'id is required',
      })
      .min(1, { message: 'At least one asset id is required' })
      .max(50, { message: 'At most 50 assets can be deleted at once' }),
  ),
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
export const MAX_BULK_FILES = 20;

export const assetBulkPresignSchema = z
  .array(assetPresignSchema, { message: 'Bulk upload payload must be an array of files' })
  .min(1, { message: 'Bulk upload must include at least one file' })
  .max(MAX_BULK_FILES, {
    message: `Bulk upload is limited to ${MAX_BULK_FILES} files per batch`,
  })
  .refine((items) => items.reduce((sum, item) => sum + item.size, 0) <= MAX_BULK_TOTAL_SIZE, {
    message: 'Combined file size exceeds the bulk upload limit',
  });

export const assetBulkConfirmSchema = z
  .array(
    z.object({
      assetId: z
        .string({ message: 'Asset id is required' })
        .min(1, { message: 'Asset id is required' }),
    }),
    { message: 'Bulk confirm payload must be an array of asset ids' },
  )
  .min(1, { message: 'Bulk confirm must include at least one asset' })
  .max(MAX_BULK_FILES, {
    message: `Bulk confirm is limited to ${MAX_BULK_FILES} assets per batch`,
  });
// POST /api/assets/:id/restore body (#325): restore an assistant-generated
// file to a prior version. The version number is the one returned by
// GET /:id/versions.
export const assetRestoreSchema = z.object({
  version: z
    .number({ message: 'version is required' })
    .int({ message: 'version must be an integer' })
    .positive({ message: 'version must be positive' }),
});
// POST /api/mcp-servers body (issue #36). Personal MCP servers only: the
// route is authenticated and always writes scope:'user' owned by the caller.
// https-only URLs keep the outbound connect surface (SSRF) off plain HTTP;
// auth is submitted as a raw token (issue #80) — the server wraps it in
// `Authorization: Bearer <token>` and stores that single header encrypted.
export const mcpServerCreateSchema = z.strictObject({
  name: z
    .string({ message: 'Name is required' })
    .min(1, { message: 'Name is required' })
    .max(60, { message: 'Name must be 60 characters or fewer' }),
  url: z
    .string({ message: 'URL is required' })
    .trim()
    .url({ message: 'URL must be a valid URL' })
    .refine((value) => value.startsWith('https://'), {
      message: 'URL must be an https URL',
    }),
  authToken: z
    .string({ message: 'authToken must be a string' })
    .max(4000, { message: 'authToken is too long' })
    .optional(),
});
