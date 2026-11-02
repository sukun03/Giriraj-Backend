import { z } from 'zod';

export const emailSchema = z.string().trim().email().max(254).transform((value) => value.toLowerCase());

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

export const passwordSchema = z.string().min(12).max(72)
  .refine((value) => Buffer.byteLength(value, 'utf8') <= 72, 'Password must be at most 72 UTF-8 bytes.');

export const forgotPasswordSchema = z.object({
  email: emailSchema,
}).strict();

export const resetPasswordSchema = z.object({
  token: z.string().min(32).max(128).regex(/^[A-Za-z0-9_-]+$/),
  password: passwordSchema,
}).strict();

const inquiryFieldSchema = z.union([
  z.string().max(3000),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(z.string().max(3000)).max(100),
]);

export const inquirySchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: emailSchema,
  phone: z.string().trim().min(5).max(30),
  message: z.string().trim().min(10).max(3000),
}).catchall(inquiryFieldSchema).superRefine((input, context) => {
  const extraFields = Object.keys(input).filter(
    (key) => !['name', 'email', 'phone', 'message'].includes(key),
  );
  if (extraFields.length > 50) {
    context.addIssue({
      code: 'custom',
      message: 'A submission may contain at most 50 additional form fields.',
    });
  }
  for (const key of extraFields) {
    if (!/^[A-Za-z0-9_. -]{1,100}$/.test(key)) {
      context.addIssue({
        code: 'custom',
        path: [key],
        message: 'Form field names must be at most 100 safe characters.',
      });
    }
  }
});

export const inquiryStatusSchema = z.object({
  status: z.enum(['new', 'contacted', 'resolved']),
}).strict();

export const pageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

export const inquiryListSchema = pageSchema.extend({
  q: z.string().trim().min(1).max(200).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  status: z.enum(['new', 'contacted', 'resolved']).optional(),
  sort: z.enum(['newest', 'oldest']).default('newest'),
}).strict().refine(
  ({ from, to }) => !from || !to || new Date(from) <= new Date(to),
  { path: ['to'], message: 'to must be on or after from.' },
);

export const reviewSchema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().trim().min(5).max(2000),
}).strict();

export const reviewSubmissionSchema = reviewSchema.extend({
  name: z.string().trim().min(1).max(100).optional(),
  email: emailSchema.optional(),
}).strict();

export const reviewStatusSchema = z.object({
  status: z.enum(['approved', 'rejected', 'pending']),
}).strict();

export const idSchema = z.string()
  .regex(/^[1-9]\d{0,18}$/)
  .refine((value) => /^[1-9]\d{0,18}$/.test(value)
    && BigInt(value) <= 9_223_372_036_854_775_807n);
