import { Router } from 'express';
import pool from '../db.js';
import { requireAdmin, requireAuth } from '../auth.js';
import { HttpError } from '../errors.js';
import { idSchema, pageSchema, reviewSchema, reviewStatusSchema } from '../validation.js';

const router = Router();

router.get('/', async (req, res) => {
  const { limit, offset } = pageSchema.parse(req.query);
  const { rows } = await pool.query(
    `SELECT r.id, r.rating, r.comment, r.created_at,
            CASE WHEN r.user_id IS NULL
                   OR (u.role = 'user' AND u.expires_at <= NOW())
                 THEN 'Former resident' ELSE r.author_name END AS author
     FROM reviews r LEFT JOIN users u ON u.id = r.user_id
     WHERE r.status = 'approved'
       AND (r.user_id IS NULL OR (
         u.disabled_at IS NULL AND (u.role = 'admin' OR u.expires_at > NOW())
       ))
     ORDER BY r.created_at DESC LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return res.json({ reviews: rows, pagination: { limit, offset } });
});

router.post('/', requireAuth, async (req, res) => {
  const input = reviewSchema.parse(req.body);
  const userId = idSchema.parse(req.auth.userId);
  const { rows } = await pool.query(
    `INSERT INTO reviews (user_id, author_name, rating, comment)
     SELECT id, name, $2, $3 FROM users
     WHERE id = $1 AND disabled_at IS NULL
     RETURNING id, user_id, rating, comment, status, created_at, updated_at`,
    [userId, input.rating, input.comment],
  );
  if (!rows[0]) throw new HttpError(401, 'ACCOUNT_UNAVAILABLE', 'This account is unavailable.');
  return res.status(201).json({ review: rows[0] });
});

router.put('/:id', requireAuth, async (req, res) => {
  const id = idSchema.parse(req.params.id);
  const userId = idSchema.parse(req.auth.userId);
  const input = reviewSchema.parse(req.body);
  const isAdmin = req.auth.role === 'admin';
  const { rows } = await pool.query(
    `UPDATE reviews
     SET rating = $1, comment = $2,
         status = CASE WHEN $4 THEN status ELSE 'pending' END,
         updated_at = NOW()
     WHERE id = $3 AND ($4 OR user_id = $5)
     RETURNING id, user_id, rating, comment, status, created_at, updated_at`,
    [input.rating, input.comment, id, isAdmin, userId],
  );
  if (!rows[0]) throw new HttpError(404, 'REVIEW_NOT_FOUND', 'Review not found.');
  return res.json({ review: rows[0] });
});

router.delete('/:id', requireAuth, async (req, res) => {
  const id = idSchema.parse(req.params.id);
  const userId = idSchema.parse(req.auth.userId);
  const isAdmin = req.auth.role === 'admin';
  const result = await pool.query(
    'DELETE FROM reviews WHERE id = $1 AND ($2 OR user_id = $3) RETURNING id',
    [id, isAdmin, userId],
  );
  if (!result.rowCount) throw new HttpError(404, 'REVIEW_NOT_FOUND', 'Review not found.');
  return res.status(204).end();
});

const adminRouter = Router();
adminRouter.use(requireAuth, requireAdmin);

adminRouter.get('/', async (req, res) => {
  const { limit, offset } = pageSchema.parse(req.query);
  const status = req.query.status;
  if (status !== undefined && !['pending', 'approved', 'rejected'].includes(status)) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'status must be pending, approved, or rejected.');
  }
  const { rows } = await pool.query(
    `SELECT r.id, r.user_id, r.rating, r.comment, r.status, r.created_at, r.updated_at,
            r.author_name AS author, u.email AS author_email
     FROM reviews r LEFT JOIN users u ON u.id = r.user_id
     WHERE ($1::text IS NULL OR r.status = $1)
     ORDER BY r.created_at DESC LIMIT $2 OFFSET $3`,
    [status ?? null, limit, offset],
  );
  return res.json({ reviews: rows, pagination: { limit, offset } });
});

adminRouter.patch('/:id/status', async (req, res) => {
  const id = idSchema.parse(req.params.id);
  const { status } = reviewStatusSchema.parse(req.body);
  const { rows } = await pool.query(
    `UPDATE reviews SET status = $1, updated_at = NOW()
     WHERE id = $2 RETURNING id, user_id, rating, comment, status, created_at, updated_at`,
    [status, id],
  );
  if (!rows[0]) throw new HttpError(404, 'REVIEW_NOT_FOUND', 'Review not found.');
  return res.json({ review: rows[0] });
});

adminRouter.delete('/:id', async (req, res) => {
  const id = idSchema.parse(req.params.id);
  const result = await pool.query(
    'DELETE FROM reviews WHERE id = $1 RETURNING id',
    [id],
  );
  if (!result.rowCount) throw new HttpError(404, 'REVIEW_NOT_FOUND', 'Review not found.');
  return res.status(204).end();
});

export { adminRouter as adminReviewsRouter };
export default router;
