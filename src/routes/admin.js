import { Router } from 'express';
import pool from '../db.js';
import { requireAdmin, requireAuth } from '../auth.js';
import { HttpError } from '../errors.js';
import { idSchema, pageSchema } from '../validation.js';

const router = Router();
router.use(requireAuth, requireAdmin);

router.get('/users', async (req, res) => {
  const { limit, offset } = pageSchema.parse(req.query);
  const { rows } = await pool.query(
    `SELECT id, name, email, role, disabled_at, created_at, expires_at
     FROM users WHERE role = 'user' AND expires_at > NOW()
     ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return res.json({ users: rows, pagination: { limit, offset } });
});

router.patch('/users/:id/disable', async (req, res) => {
  const id = idSchema.parse(req.params.id);
  if (req.body?.disabled !== true && req.body?.disabled !== false) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'disabled must be a boolean.');
  }
  const { rows } = await pool.query(
    `UPDATE users SET disabled_at = CASE WHEN $1 THEN NOW() ELSE NULL END
     WHERE id = $2 AND role = 'user'
     RETURNING id, name, email, role, disabled_at, created_at, expires_at`,
    [req.body.disabled, id],
  );
  if (!rows[0]) throw new HttpError(404, 'USER_NOT_FOUND', 'User not found.');
  return res.json({ user: rows[0] });
});

export default router;
