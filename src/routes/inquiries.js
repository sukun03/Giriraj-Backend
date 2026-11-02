import { Router } from 'express';
import pool from '../db.js';
import { requireAdmin, requireAuth } from '../auth.js';
import { HttpError } from '../errors.js';
import {
  idSchema,
  inquiryListSchema,
  inquirySchema,
  inquiryStatusSchema,
} from '../validation.js';

const router = Router();

router.post('/', async (req, res) => {
  const input = inquirySchema.parse(req.body);
  const { name, email, phone, message, ...formData } = input;
  const { rows } = await pool.query(
    `INSERT INTO inquiries (name, email, phone, message, form_data)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, name, email, phone, message, form_data, status, created_at, updated_at`,
    [name, email, phone, message, JSON.stringify(formData)],
  );
  return res.status(201).json({ inquiry: rows[0] });
});

router.use(requireAuth, requireAdmin);

router.get('/', async (req, res) => {
  const { limit, offset, q, from, to, status, sort } = inquiryListSchema.parse(req.query);
  const filters = [q ?? null, status ?? null, from ?? null, to ?? null];
  const sortDirection = sort === 'newest' ? 'DESC' : 'ASC';
  const where = `WHERE ($1::text IS NULL OR
      name ILIKE '%' || $1 || '%' OR email ILIKE '%' || $1 || '%' OR
      phone ILIKE '%' || $1 || '%' OR message ILIKE '%' || $1 || '%' OR
      form_data::text ILIKE '%' || $1 || '%')
    AND ($2::text IS NULL OR status = $2)
    AND ($3::timestamptz IS NULL OR created_at >= $3)
    AND ($4::timestamptz IS NULL OR created_at <= $4)`;
  const [{ rows: countRows }, { rows }] = await Promise.all([
    pool.query(`SELECT COUNT(*)::text AS total FROM inquiries ${where}`, filters),
    pool.query(
      `SELECT id, name, email, phone, message, form_data, status, created_at, updated_at
       FROM inquiries ${where}
       ORDER BY created_at ${sortDirection}, id ${sortDirection}
       LIMIT $5 OFFSET $6`,
      [...filters, limit, offset],
    ),
  ]);
  return res.json({
    inquiries: rows,
    pagination: { limit, offset, total: Number(countRows[0].total) },
  });
});

router.get('/:id', async (req, res) => {
  const id = idSchema.parse(req.params.id);
  const { rows } = await pool.query(
    `SELECT id, name, email, phone, message, form_data, status, created_at, updated_at
     FROM inquiries WHERE id = $1`,
    [id],
  );
  if (!rows[0]) throw new HttpError(404, 'INQUIRY_NOT_FOUND', 'Inquiry not found.');
  return res.json({ inquiry: rows[0] });
});

router.put('/:id', async (req, res) => {
  const id = idSchema.parse(req.params.id);
  const input = inquirySchema.parse(req.body);
  const { name, email, phone, message, ...formData } = input;
  const { rows } = await pool.query(
    `UPDATE inquiries
     SET name = $1, email = $2, phone = $3, message = $4, form_data = $5, updated_at = NOW()
     WHERE id = $6
     RETURNING id, name, email, phone, message, form_data, status, created_at, updated_at`,
    [name, email, phone, message, JSON.stringify(formData), id],
  );
  if (!rows[0]) throw new HttpError(404, 'INQUIRY_NOT_FOUND', 'Inquiry not found.');
  return res.json({ inquiry: rows[0] });
});

router.patch('/:id/status', async (req, res) => {
  const id = idSchema.parse(req.params.id);
  const { status } = inquiryStatusSchema.parse(req.body);
  const { rows } = await pool.query(
    `UPDATE inquiries SET status = $1, updated_at = NOW()
     WHERE id = $2
     RETURNING id, name, email, phone, message, form_data, status, created_at, updated_at`,
    [status, id],
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
