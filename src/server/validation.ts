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

// POST /api/mcp-servers body (issue #36). Personal MCP servers only: the
// route is authenticated and always writes scope:'user' owned by the caller.
// https-only URLs keep the outbound connect surface (SSRF) off plain HTTP;
// the header value is a raw "Header: value" spec the server stores encrypted.
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
  authHeader: z
    .string({ message: 'authHeader must be a string' })
    .max(4000, { message: 'authHeader is too long' })
    .regex(/^[A-Za-z0-9-]+:\s?.+$/, {
      message: 'authHeader must look like "Header-Name: value"',
    })
    .optional(),
});

export type LoginCredentials = z.infer<typeof loginSchema>;
export type RegisterCredentials = z.infer<typeof registerSchema>;
