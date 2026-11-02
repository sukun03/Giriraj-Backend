import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pool from './db.js';
import { HttpError } from './errors.js';
import { idSchema } from './validation.js';

const JWT_ISSUER = 'pg-stay-api';
const JWT_AUDIENCE = 'pg-stay-api';

function jwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new HttpError(503, 'AUTH_NOT_CONFIGURED', 'Authentication is not configured.');
  }
  return secret;
}

export async function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

export function issueToken(user) {
  return jwt.sign(
    { role: user.role, ver: user.auth_version ?? 0 },
    jwtSecret(),
    {
      algorithm: 'HS256',
      subject: String(user.id),
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      expiresIn: '15m',
    },
  );
}



export async function requireAuth(req, res, next) {
  const header = req.get('authorization');
  if (!header?.startsWith('Bearer ')) {
    return next(new HttpError(401, 'AUTH_REQUIRED', 'A bearer access token is required.'));
  }

  let payload;
  try {
    payload = jwt.verify(header.slice(7), jwtSecret(), {
      algorithms: ['HS256'],
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });
  } catch {
    return next(new HttpError(401, 'INVALID_TOKEN', 'The access token is invalid or expired.'));
  } 

  if (typeof payload !== 'object' || !payload.sub || !['user', 'admin'].includes(payload.role)) {
    return next(new HttpError(401, 'INVALID_TOKEN', 'The access token is invalid or expired.'));
  }
  const parsedUserId = idSchema.safeParse(payload.sub);
  if (!parsedUserId.success) {
    return next(new HttpError(401, 'INVALID_TOKEN', 'The access token is invalid or expired.'));
  }
  const userId = parsedUserId.data;
  const { rows } = await pool.query(
    'SELECT role, disabled_at, auth_version FROM users WHERE id = $1',
    [userId],
  );
  if (!rows[0] || rows[0].disabled_at) {
    return next(new HttpError(401, 'ACCOUNT_UNAVAILABLE', 'This account is unavailable.'));
  }
  if (payload.ver !== rows[0].auth_version) {
    return next(new HttpError(401, 'INVALID_TOKEN', 'The access token is invalid or expired.'));
  }
  req.auth = { userId, role: rows[0].role };
  return next();
}

export function optionalAuth(req, res, next) {
  if (!req.get('authorization')) {
    return next();
  }
  return requireAuth(req, res, next);
}

export function requireAdmin(req, res, next) {
  if (req.auth?.role !== 'admin') {
    return next(new HttpError(403, 'FORBIDDEN', 'Administrator access is required.'));
  }
  return next();
}
