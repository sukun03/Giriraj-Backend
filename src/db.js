import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';

const externalUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
const embedded = !externalUrl;
if (embedded && (process.env.NODE_ENV === 'production' || process.env.VERCEL === '1')) {
  throw new Error(
    'Set DATABASE_URL or POSTGRES_URL in production and on Vercel; the embedded database is only for local development.',
  );
}
const embeddedDataDir = path.resolve(process.env.PGLITE_DATA_DIR ?? 'data/postgres');
if (embedded) {
  await mkdir(path.dirname(embeddedDataDir), { recursive: true });
}
const pool = embedded
  ? new PGlite(embeddedDataDir)
  : new pg.Pool({
    connectionString: externalUrl,
    max: process.env.VERCEL === '1' ? 1 : 10,
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
    '../database/migrations/003_permanent_records_and_single_admin.sql',
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
  const result = await pool.query('DELETE FROM password_reset_tokens WHERE expires_at <= NOW()');
  return { passwordResetTokens: result.rowCount ?? 0 };
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
