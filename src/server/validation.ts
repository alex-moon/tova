import { z } from 'zod';

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
  // Granular delete-confirmation prefs (issue #59). Strict sub-object: an
  // unknown delete target is a 400, not a silently dropped key.
  confirmDeletes: z
    .strictObject({
      chat: z.boolean().optional(),
      file: z.boolean().optional(),
    })
    .optional(),
});

export const feedbackValueSchema = z.object({
  value: z.enum(['up', 'down'], { message: 'value must be "up" or "down"' }),
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
});

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
// any layer (ALLOWED_CONTENT_TYPES in routes/assets.ts excludes it), and
// uploaded archives are never read or unzipped anywhere.
//
// These schemas shape the batch; per-item content-type/size policy lives in
// the routes (validation.ts knows shapes, routes know policy). The total
// declared size cap is a batch-shape guard here: one HTTP request must not
// carry an unbounded array of sizes.
export const MAX_BULK_FILES = 20;
// 20 files x 15 MB nominal per-file cap.
export const MAX_BULK_TOTAL_SIZE = 300 * 1024 * 1024;

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

export type LoginCredentials = z.infer<typeof loginSchema>;
export type RegisterCredentials = z.infer<typeof registerSchema>;
