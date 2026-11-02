import { transaction } from './db.js';
import { hashPassword } from './auth.js';
import { HttpError } from './errors.js';
import { emailSchema, passwordSchema, registerSchema } from './validation.js';

export async function createAdminAccount(input) {
  const { name, email, password } = registerSchema.parse(input);
  const passwordHash = await hashPassword(password);
  return transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [7_431_025]);
    const { rows: admins } = await client.query(
      "SELECT id FROM users WHERE role = 'admin' LIMIT 1",
    );
    if (admins.length) {
      throw new HttpError(409, 'ADMIN_ALREADY_EXISTS', 'An administrator account already exists.');
    }
    const { rows } = await client.query(
      `INSERT INTO users (name, email, password_hash, role)
       VALUES ($1, $2, $3, 'admin')
       RETURNING id`,
      [name, email, passwordHash],
    );
    return rows[0];
  });
}

export async function changeAdminEmail(value) {
  const email = emailSchema.parse(value);
  return transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [7_431_025]);
    const { rows } = await client.query(
      `UPDATE users
       SET email = $1, auth_version = auth_version + 1
       WHERE role = 'admin'
       RETURNING id`,
      [email],
    );
    if (!rows[0]) {
      throw new HttpError(404, 'ADMIN_NOT_FOUND', 'No administrator account exists.');
    }
    await client.query('DELETE FROM password_reset_tokens WHERE user_id = $1', [rows[0].id]);
    return rows[0];
  });
}

export async function resetAdminPassword(value) {
  const password = passwordSchema.parse(value);
  const passwordHash = await hashPassword(password);
  return transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [7_431_025]);
    const { rows } = await client.query(
      `UPDATE users
       SET password_hash = $1, auth_version = auth_version + 1
       WHERE role = 'admin'
       RETURNING id`,
      [passwordHash],
    );
    if (!rows[0]) {
      throw new HttpError(404, 'ADMIN_NOT_FOUND', 'No administrator account exists.');
    }
    await client.query('DELETE FROM password_reset_tokens WHERE user_id = $1', [rows[0].id]);
    return rows[0];
  });
}
