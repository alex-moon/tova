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

export const feedbackValueSchema = z.object({
  value: z.enum(['up', 'down'], { message: 'value must be "up" or "down"' }),
});

export type LoginCredentials = z.infer<typeof loginSchema>;
export type RegisterCredentials = z.infer<typeof registerSchema>;
