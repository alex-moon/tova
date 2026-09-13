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
// are untouched; present keys set the field (trimmed empty string clears).
export const profilePatchSchema = z.strictObject({
  preferredName: z
    .string({ message: 'preferredName must be a string' })
    .max(100, { message: 'preferredName must be 100 characters or fewer' })
    .optional(),
  systemPrompt: z
    .string({ message: 'systemPrompt must be a string' })
    .max(4000, { message: 'systemPrompt must be 4000 characters or fewer' })
    .optional(),
});

export const feedbackValueSchema = z.object({
  value: z.enum(['up', 'down'], { message: 'value must be "up" or "down"' }),
});

export type LoginCredentials = z.infer<typeof loginSchema>;
export type RegisterCredentials = z.infer<typeof registerSchema>;
