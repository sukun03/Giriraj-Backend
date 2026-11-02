import { readFile } from 'node:fs/promises';
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

const app = express();
const here = path.dirname(fileURLToPath(import.meta.url));

const allowedOrigins = (process.env.CORS_ORIGINS
  ?? (process.env.NODE_ENV === 'production'
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
if (process.env.NODE_ENV === 'production' && allowedOrigins.length === 0) {
  throw new Error('Set CORS_ORIGINS to your deployed React frontend origin in production.');
}

app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false);
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
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Admin-Bootstrap-Key'],
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
app.use([
  '/api/auth/register',
  '/api/auth/login',
  '/api/auth/password/forgot',
  '/api/auth/password/reset',
  '/api/auth/admin/bootstrap',
], rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
}));

app.get('/health', (req, res) => res.json({ status: 'ok' }));
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
