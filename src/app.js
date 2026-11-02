import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import swaggerUi from 'swagger-ui-express';
import { parse as parseYaml } from 'yaml';
import authRoutes from './routes/auth.js';
import inquiryRoutes from './routes/inquiries.js';
import reviewRoutes, { adminReviewsRouter } from './routes/reviews.js';
import adminRoutes from './routes/admin.js';
import { errorHandler, HttpError } from './errors.js';
import pool, { cleanupExpiredData } from './db.js';

const app = express();
const here = path.dirname(fileURLToPath(import.meta.url));

const isProduction = process.env.NODE_ENV === 'production' || process.env.VERCEL === '1';
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  throw new Error('JWT_SECRET must be set to at least 32 characters.');
}

const allowedOrigins = (process.env.CORS_ORIGINS
  ?? (isProduction
    ? ''
    : 'http://localhost:5173,http://127.0.0.1:5173'))
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

if (allowedOrigins.includes('*')) {
  throw new Error('CORS_ORIGINS must list explicit frontend origins; wildcard origins are not allowed.');
}
for (const origin of allowedOrigins) {
  let parsedOrigin;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    throw new Error(`CORS_ORIGINS contains an invalid origin: ${origin}`);
  }
  if (!['http:', 'https:'].includes(parsedOrigin.protocol)
      || parsedOrigin.origin !== origin
      || parsedOrigin.username
      || parsedOrigin.password) {
    throw new Error(`CORS_ORIGINS entries must be plain HTTP(S) origins without paths: ${origin}`);
  }
}
app.disable('x-powered-by');
app.set(
  'trust proxy',
  process.env.VERCEL === '1' || process.env.TRUST_PROXY === 'true' ? 1 : false,
);
app.use((req, res, next) => {
  const docsCsp = {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
    },
  };
  const securityHeaders = req.path.startsWith('/api-docs')
    ? helmet({ contentSecurityPolicy: docsCsp })
    : helmet();
  return securityHeaders(req, res, next);
});
app.use(cors({
  origin(origin, callback) {
    callback(null, !origin || allowedOrigins.includes(origin));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86_400,
  optionsSuccessStatus: 204,
}));
app.use(express.json({ limit: '20kb' }));
app.use('/api', rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
}));
for (const route of [
  '/api/auth/register',
  '/api/auth/login',
  '/api/auth/password/forgot',
  '/api/auth/password/reset',
]) {
  app.use(route, rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
  }));
}
app.use('/api/inquiries', rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: (req) => req.method !== 'POST',
}));
app.use('/api/reviews', rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: (req) => req.method !== 'POST',
}));

app.get('/', (req, res) => res.json({
  service: 'Giriraj Boys PG API',
  documentation: '/api-docs/',
  openapi: '/api-docs.json',
  health: '/health',
}));

app.get('/health', async (req, res) => {
  await pool.query('SELECT 1');
  return res.json({ status: 'ok' });
});
app.get('/api/cron/cleanup', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 32) {
    throw new HttpError(503, 'CRON_NOT_CONFIGURED', 'Scheduled cleanup is not configured.');
  }

  const authorization = req.get('authorization') ?? '';
  const providedSecret = authorization.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length)
    : '';
  const expectedBuffer = Buffer.from(secret);
  const providedBuffer = Buffer.from(providedSecret);
  if (providedBuffer.length !== expectedBuffer.length
      || !timingSafeEqual(providedBuffer, expectedBuffer)) {
    throw new HttpError(401, 'INVALID_CRON_SECRET', 'The scheduled cleanup authorization is invalid.');
  }

  const removed = await cleanupExpiredData();
  return res.json({ status: 'ok', removed });
});
app.use('/api/auth', authRoutes);
app.use('/api/inquiries', inquiryRoutes);
app.use('/api/reviews', reviewRoutes);
app.use('/api/admin/reviews', adminReviewsRouter);
app.use('/api/admin', adminRoutes);

const openapiText = await readFile(path.join(here, 'openapi.yaml'), 'utf8');
const openapiDocument = parseYaml(openapiText);
app.get('/api-docs.json', (req, res) => res.json(openapiDocument));
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openapiDocument, {
  explorer: true,
  customSiteTitle: 'Giriraj Boys PG API documentation',
}));

app.use('/api', (req, res, next) => next(
  new HttpError(404, 'ROUTE_NOT_FOUND', 'API route not found. See /api-docs.'),
));
app.use((req, res, next) => next(new HttpError(404, 'NOT_FOUND', 'Page not found.')));
app.use(errorHandler);

export default app;
