import { Router } from 'express';
import pool from '../db.js';
import { requireAdmin, requireAuth } from '../auth.js';
import { HttpError } from '../errors.js';
import { idSchema, inquirySchema, pageSchema } from '../validation.js';

const router = Router();

router.post('/', async (req, res) => {
  const input = inquirySchema.parse(req.body);
  const { rows } = await pool.query(
    `INSERT INTO inquiries (name, email, phone, message)
     VALUES ($1, $2, $3, $4)
     RETURNING id, name, email, phone, message, created_at, expires_at`,
    [input.name, input.email, input.phone, input.message],
  );
  return res.status(201).json({ inquiry: rows[0] });
});

router.use(requireAuth, requireAdmin);

router.get('/', async (req, res) => {
  const { limit, offset } = pageSchema.parse(req.query);
  const { rows } = await pool.query(
    `SELECT id, name, email, phone, message, created_at, updated_at, expires_at
     FROM inquiries WHERE expires_at > NOW()
     ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return res.json({ inquiries: rows, pagination: { limit, offset } });
});

router.get('/:id', async (req, res) => {
  const id = idSchema.parse(req.params.id);
  const { rows } = await pool.query(
    `SELECT id, name, email, phone, message, created_at, updated_at, expires_at
     FROM inquiries WHERE id = $1 AND expires_at > NOW()`,
    [id],
  );
  if (!rows[0]) throw new HttpError(404, 'INQUIRY_NOT_FOUND', 'Inquiry not found.');
  return res.json({ inquiry: rows[0] });
});

router.put('/:id', async (req, res) => {
  const id = idSchema.parse(req.params.id);
  const input = inquirySchema.parse(req.body);
  const { rows } = await pool.query(
    `UPDATE inquiries
     SET name = $1, email = $2, phone = $3, message = $4, updated_at = NOW()
     WHERE id = $5 AND expires_at > NOW()
     RETURNING id, name, email, phone, message, created_at, updated_at, expires_at`,
    [input.name, input.email, input.phone, input.message, id],
  );
  if (!rows[0]) throw new HttpError(404, 'INQUIRY_NOT_FOUND', 'Inquiry not found.');
  return res.json({ inquiry: rows[0] });
});

router.delete('/:id', async (req, res) => {
  const id = idSchema.parse(req.params.id);
  const result = await pool.query(
    'DELETE FROM inquiries WHERE id = $1 RETURNING id',
    [id],
  );
  if (!result.rowCount) throw new HttpError(404, 'INQUIRY_NOT_FOUND', 'Inquiry not found.');
  return res.status(204).end();
});

export default router;
