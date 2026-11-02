import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';

const externalUrl = process.env.DATABASE_URL;
const embedded = !externalUrl;
const embeddedDataDir = path.resolve(process.env.PGLITE_DATA_DIR ?? 'data/postgres');
if (embedded) {
  await mkdir(path.dirname(embeddedDataDir), { recursive: true });
}
const pool = embedded
  ? new PGlite(embeddedDataDir)
  : new pg.Pool({
    connectionString: externalUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

if (embedded) {
  await pool.waitReady;
} else {
  pool.on('error', (error) => {
    console.error('Unexpected PostgreSQL pool error:', error);
  });
}

export async function transaction(callback) {
  if (embedded) {
    return pool.transaction(callback);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function migrate() {
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const migrationFiles = [
    '../database/migrations/001_initial.sql',
    '../database/migrations/002_retention_and_password_resets.sql',
  ];
  for (const migrationFile of migrationFiles) {
    const migrationPath = new URL(migrationFile, import.meta.url);
    const migration = await readFile(fileURLToPath(migrationPath), 'utf8');
    if (embedded) {
      await pool.exec(migration);
    } else {
      await pool.query(migration);
    }
  }
}

export async function cleanupExpiredData() {
  return transaction(async (client) => {
    await client.query(
      `UPDATE reviews
       SET user_id = NULL, author_name = 'Former resident'
       WHERE user_id IN (
         SELECT id FROM users
         WHERE role = 'user' AND expires_at <= NOW()
       )`,
    );
    const expiredUsers = await client.query(
      "DELETE FROM users WHERE role = 'user' AND expires_at <= NOW()",
    );
    const expiredInquiries = await client.query(
      'DELETE FROM inquiries WHERE expires_at <= NOW()',
    );
    await client.query('DELETE FROM password_reset_tokens WHERE expires_at <= NOW()');
    return {
      users: expiredUsers.rowCount ?? 0,
      inquiries: expiredInquiries.rowCount ?? 0,
    };
  });
}

export async function closeDatabase() {
  if (embedded) {
    await pool.close();
  } else {
    await pool.end();
  }
}

export const databaseMode = embedded ? 'embedded PostgreSQL' : 'PostgreSQL';
export default pool;
