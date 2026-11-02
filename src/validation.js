import { z } from 'zod';

const emailSchema = z.string().trim().email().max(254).transform((value) => value.toLowerCase());

export const registerSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: emailSchema,
  password: z.string().min(12).max(72)
    .refine((value) => Buffer.byteLength(value, 'utf8') <= 72, 'Password must be at most 72 UTF-8 bytes.'),
}).strict();

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(72),
}).strict();

const passwordSchema = z.string().min(12).max(72)
  .refine((value) => Buffer.byteLength(value, 'utf8') <= 72, 'Password must be at most 72 UTF-8 bytes.');

export const forgotPasswordSchema = z.object({
  email: emailSchema,
}).strict();

export const resetPasswordSchema = z.object({
  token: z.string().min(32).max(128).regex(/^[A-Za-z0-9_-]+$/),
  password: passwordSchema,
}).strict();

export const inquirySchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: emailSchema,
  phone: z.string().trim().min(5).max(30),
  message: z.string().trim().min(10).max(3000),
}).strict();

export const reviewSchema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().trim().min(5).max(2000),
}).strict();

export const reviewStatusSchema = z.object({
  status: z.enum(['approved', 'rejected', 'pending']),
}).strict();

export const pageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

export const idSchema = z.string()
  .regex(/^[1-9]\d{0,18}$/)
  .refine((value) => /^[1-9]\d{0,18}$/.test(value)
    && BigInt(value) <= 9_223_372_036_854_775_807n);
