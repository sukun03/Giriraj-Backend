import { Router } from 'express';
import crypto from 'node:crypto';
import pool, { transaction } from '../db.js';
import { hashPassword, issueToken, requireAuth, verifyPassword } from '../auth.js';
import { HttpError } from '../errors.js';
import { getMailConfig, sendPasswordResetEmail } from '../mailer.js';
import {
  forgotPasswordSchema,
  idSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
} from '../validation.js';

const router = Router();

function publicUser(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    createdAt: row.created_at,
  };
}

function hashResetToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

router.post('/register', async (req, res) => {
  const input = registerSchema.parse(req.body);
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    throw new HttpError(503, 'AUTH_NOT_CONFIGURED', 'Authentication is not configured.');
  }
  const passwordHash = await hashPassword(input.password);
  const { rows } = await pool.query(
    `INSERT INTO users (name, email, password_hash, expires_at)
     VALUES ($1, $2, $3, NOW() + INTERVAL '30 days')
     RETURNING id, name, email, role, created_at, auth_version, expires_at`,
    [input.name, input.email, passwordHash],
  );
  const user = publicUser(rows[0]);
  return res.status(201).json({ user, accessToken: issueToken(user), tokenType: 'Bearer', expiresIn: 900 });
});

router.post('/login', async (req, res) => {
  const input = loginSchema.parse(req.body);
  const { rows } = await pool.query(
    `SELECT id, name, email, role, password_hash, disabled_at, created_at, auth_version, expires_at
     FROM users WHERE email = $1`,
    [input.email],
  );
  const user = rows[0];
  if (!user || !(await verifyPassword(input.password, user.password_hash))) {
    throw new HttpError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
  }
  if (user.disabled_at) {
    throw new HttpError(403, 'ACCOUNT_DISABLED', 'This account has been disabled.');
  }
  if (user.role === 'user' && (!user.expires_at || new Date(user.expires_at) <= new Date())) {
    throw new HttpError(403, 'ACCOUNT_EXPIRED', 'This account has expired.');
  }

  const safeUser = publicUser(user);
  return res.json({
    user: safeUser,
    accessToken: issueToken({ ...safeUser, auth_version: user.auth_version }),
    tokenType: 'Bearer',
    expiresIn: 900,
  });
});

router.post('/password/forgot', async (req, res) => {
  const { email } = forgotPasswordSchema.parse(req.body);
  getMailConfig();
  const { rows } = await pool.query(
    `SELECT id FROM users
     WHERE email = $1 AND disabled_at IS NULL
       AND (role = 'admin' OR expires_at > NOW())`,
    [email],
  );

  if (rows[0]) {
    const token = crypto.randomBytes(32).toString('base64url');
    const tokenHash = hashResetToken(token);
    await transaction(async (client) => {
      await client.query('DELETE FROM password_reset_tokens WHERE user_id = $1', [rows[0].id]);
      await client.query(
        `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
         VALUES ($1, $2, NOW() + INTERVAL '30 minutes')`,
        [rows[0].id, tokenHash],
      );
    });

    try {
      await sendPasswordResetEmail({ to: email, token });
    } catch (error) {
      await pool.query('DELETE FROM password_reset_tokens WHERE token_hash = $1', [tokenHash]);
      throw error;
    }
  }

  return res.status(202).json({
    message: 'If an active account exists for that email, a password reset link has been sent.',
    resetLinkExpiresIn: 1800,
  });
});

router.post('/password/reset', async (req, res) => {
  const input = resetPasswordSchema.parse(req.body);
  const tokenHash = hashResetToken(input.token);
  const passwordHash = await hashPassword(input.password);

  await transaction(async (client) => {
    const { rows } = await client.query(
      `SELECT t.user_id FROM password_reset_tokens t
       JOIN users u ON u.id = t.user_id AND u.disabled_at IS NULL
         AND (u.role = 'admin' OR u.expires_at > NOW())
       WHERE t.token_hash = $1 AND t.expires_at > NOW()
       FOR UPDATE`,
      [tokenHash],
    );
    if (!rows[0]) {
      throw new HttpError(400, 'RESET_TOKEN_INVALID', 'The reset link is invalid, expired, or already used.');
    }

    await client.query(
      `UPDATE users SET password_hash = $1, auth_version = auth_version + 1
       WHERE id = $2`,
      [passwordHash, rows[0].user_id],
    );
    await client.query('DELETE FROM password_reset_tokens WHERE user_id = $1', [rows[0].user_id]);
  });

  return res.json({
    message: 'Password reset successfully. Sign in with your new password.',
  });
});

router.post('/admin/bootstrap', async (req, res) => {
  const expectedKey = process.env.ADMIN_BOOTSTRAP_KEY;
  if (!expectedKey || expectedKey.length < 32) {
    throw new HttpError(503, 'BOOTSTRAP_NOT_CONFIGURED', 'Admin bootstrap is not configured.');
  }
  const providedKey = req.get('x-admin-bootstrap-key') ?? '';
  const expectedBuffer = Buffer.from(expectedKey);
  const providedBuffer = Buffer.from(providedKey);
  if (providedBuffer.length !== expectedBuffer.length
      || !crypto.timingSafeEqual(providedBuffer, expectedBuffer)) {
    throw new HttpError(401, 'INVALID_BOOTSTRAP_KEY', 'The admin bootstrap key is invalid.');
  }

  const input = registerSchema.parse(req.body);
  const passwordHash = await hashPassword(input.password);
  const userRow = await transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [7_431_025]);
    const { rows: admins } = await client.query(
      "SELECT id FROM users WHERE role = 'admin' LIMIT 1",
    );
    if (admins.length) {
      throw new HttpError(409, 'ADMIN_ALREADY_EXISTS', 'An administrator account has already been created.');
    }
    const { rows } = await client.query(
      `INSERT INTO users (name, email, password_hash, role)
       VALUES ($1, $2, $3, 'admin')
       RETURNING id, name, email, role, created_at`,
      [input.name, input.email, passwordHash],
    );
    return rows[0];
  });
  const user = publicUser(userRow);
  return res.status(201).json({
    user,
    accessToken: issueToken(user),
    tokenType: 'Bearer',
    expiresIn: 900,
  });
});

router.get('/me', requireAuth, async (req, res) => {
  const userId = idSchema.parse(req.auth.userId);
  const { rows } = await pool.query(
    `SELECT id, name, email, role, disabled_at, created_at
     FROM users WHERE id = $1`,
    [userId],
  );
  const user = rows[0];
  if (!user || user.disabled_at) {
    throw new HttpError(401, 'ACCOUNT_UNAVAILABLE', 'This account is unavailable.');
  }
  return res.json({ user: publicUser(user) });
});

export default router;
