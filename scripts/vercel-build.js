import 'dotenv/config';

process.env.NODE_ENV = 'production';

if (!process.env.DATABASE_URL) {
  throw new Error('Set DATABASE_URL in the Vercel build environment.');
}
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  throw new Error('Set JWT_SECRET to a private secret of at least 32 characters in Vercel.');
}
if (!process.env.CRON_SECRET || process.env.CRON_SECRET.length < 32) {
  throw new Error('Set CRON_SECRET to a private secret of at least 32 characters in Vercel.');
}
if (!process.env.CORS_ORIGINS?.trim()) {
  throw new Error('Set CORS_ORIGINS to the exact deployed frontend origin in Vercel.');
}

await import('../src/app.js');
const { closeDatabase, migrate } = await import('../src/db.js');

try {
  await migrate();
  console.log('Vercel environment validated and database migrations completed.');
} finally {
  await closeDatabase();
}
