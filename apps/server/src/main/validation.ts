import { z } from 'zod';
import { CONNECTOR_TYPES } from '@tova/shared';
import { MAX_BULK_TOTAL_SIZE } from './services/assetLimits';

// First zod issue message, else the caller's fallback.
// @see #398
export const zodMessage = (
  parsed: { success: false; error: { issues: { message?: string }[] } },
  fallback: string,
): string => parsed.error.issues[0]?.message ?? fallback;

// Canonical IANA zones + UTC/GMT aliases, computed once at import.
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

// POST /api/admin/pats body: display name for the token.
// @see #184
export const createPatSchema = z.object({
  name: z
    .string({ message: 'Name is required' })
    .min(1, { message: 'Name is required' })
    .max(100, { message: 'Name must be at most 100 characters' }),
});

// PATCH /api/profile body. Strict: unknown keys 400, empty clears.
// @see #35
// preferredName: 20 chars max; charset tightened server-side.
// @see #46
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
  // Startup chat: latest chat (default) or a blank new chat.
  // @see #96
  startupChat: z
    .enum(['recent', 'new'], {
      message: 'startupChat must be "recent" or "new"',
    })
    .optional(),
  // ZDR preference: no chat persistence; wiping is /factory-reset only.
  // @see #116 #143
  zdr: z.boolean({ message: 'zdr must be a boolean' }).optional(),
  // 'Incognito by default': new chats start incognito when set.
  // @see #144
  // Same settings.zdr slot; `zdr` is the legacy alias — rename together.
  // @see #116
  incognitoByDefault: z.boolean({ message: 'incognitoByDefault must be a boolean' }).optional(),
  // Delete-confirm prefs; an unknown target is a 400, never dropped.
  // @see #59
  confirmDeletes: z
    .strictObject({
      chat: z.boolean().optional(),
      file: z.boolean().optional(),
    })
    .optional(),
  // Browser IANA zone, validated so `Intl.DateTimeFormat` cannot throw.
  // @see #261
  timezone: z
    .string({ message: 'timezone must be a string' })
    .max(64, { message: 'timezone must be 64 characters or fewer' })
    .refine(isKnownTimezone, { message: 'timezone must be a valid IANA timezone' })
    .optional(),
});

// Factory reset: the exact string a user must type; a product literal.
// @see #143
export const FACTORY_RESET_CONFIRM = 'RESET';

export const factoryResetSchema = z.strictObject({
  confirm: z.literal(FACTORY_RESET_CONFIRM, {
    message: `Type ${FACTORY_RESET_CONFIRM} to confirm the factory reset`,
  }),
});

export const feedbackValueSchema = z.object({
  value: z.enum(['up', 'down'], { message: 'value must be "up" or "down"' }),
});

// Task creation: `instruction` optional but never empty, `origin` a thin ref.
// @see #254 #395
export const taskCreateSchema = z.strictObject({
  instruction: z
    .string({ message: 'instruction must be a string' })
    .min(1, { message: 'instruction must not be empty' })
    .max(4000, { message: 'instruction must be 4000 characters or fewer' })
    .optional(),
  origin: z
    .strictObject({
      kind: z.enum(['chat', 'direct'], { message: 'origin.kind must be "chat" or "direct"' }),
      sessionId: z.string({ message: 'origin.sessionId must be a string' }).optional(),
    })
    .optional(),
});

// Steering turn / resume; non-empty — an empty turn has nothing to say.
export const taskInstructionSchema = z.strictObject({
  instruction: z
    .string({ message: 'instruction is required' })
    .min(1, { message: 'instruction must not be empty' })
    .max(4000, { message: 'instruction must be 4000 characters or fewer' }),
});

// Uploads go browser-to-Spaces; presign validates metadata only.
// @see #34
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
  // Upload origin tags ZDR attachments; the per-chat flag still decides.
  // @see #116 #144
  scope: z.enum(['chat'], { message: 'scope must be "chat"' }).optional(),
  // Stored flag decides; new incognito sends `zdr`; else profile default.
  // @see #144
  chatId: z.string({ message: 'chatId must be a string' }).optional(),
  zdr: z.boolean({ message: 'zdr must be a boolean' }).optional(),
});

// ZDR chats are stateless: bound the client replay hard.
// @see #116
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

// Repeated `?id=` is array vs scalar in Express 5; normalise, cap 50.
// @see #69
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

// Bulk-delete shares the `?id=` contract; wording fits both routes.
// @see #69
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
// Bulk upload: one presign/confirm round-trip; never zip; capped.
// @see #68
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
// Restore to a prior version; the number GET /:id/versions returned.
// @see #325
export const assetRestoreSchema = z.object({
  version: z
    .number({ message: 'version is required' })
    .int({ message: 'version must be an integer' })
    .positive({ message: 'version must be positive' }),
});
/* Connector body: personal rows, https-only URLs, encrypted bearer. */
// @see #36 #329 #327 #80
export const connectorCreateSchema = z.strictObject({
  type: z
    .enum(CONNECTOR_TYPES, {
      error: (iss) =>
        iss.input === undefined ? 'Connector type is required' : 'Unknown connector type',
    })
    .superRefine((value, ctx) => {
      if (value === 'mcp.pat') return;
      ctx.addIssue({
        code: 'custom',
        message:
          value === 'mcp.oauth'
            ? 'This connector connects via OAuth sign-in — use the browser connect flow, not a pasted token'
            : 'This connector type is not supported yet',
      });
    }),
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

// Begin consent; the row exists only when the flow completes.
// @see #327
export const connectorOAuthStartSchema = z.strictObject({
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
});

// Consent redirect params from the client callback; `state` keys it.
// @see #327
export const connectorOAuthCallbackSchema = z.strictObject({
  code: z.string({ message: 'code is required' }).min(1, { message: 'code is required' }).max(4000),
  state: z
    .string({ message: 'state is required' })
    .min(1, { message: 'state is required' })
    .max(256),
});
