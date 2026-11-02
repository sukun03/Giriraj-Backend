import 'dotenv/config';
import app from './app.js';
import pool, {
  cleanupExpiredData,
  closeDatabase,
  databaseMode,
  migrate,
} from './db.js';

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error('PORT must be a valid TCP port.');
}
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  throw new Error('JWT_SECRET must be set to at least 32 characters.');
}

await migrate();
await pool.query('SELECT 1');
const initialCleanup = await cleanupExpiredData();
if (initialCleanup.users || initialCleanup.inquiries) {
  console.log(
    `Removed ${initialCleanup.users} expired account(s) and ${initialCleanup.inquiries} expired inquiry(ies).`,
  );
}
const server = app.listen(port, () => {
  console.log(`PG Stay API listening on http://localhost:${port} (${databaseMode})`);
});

const cleanupTimer = setInterval(async () => {
  try {
    const result = await cleanupExpiredData();
    if (result.users || result.inquiries) {
      console.log(
        `Removed ${result.users} expired account(s) and ${result.inquiries} expired inquiry(ies).`,
      );
    }
  } catch (error) {
    console.error('Data retention cleanup failed:', error);
  }
}, 60 * 60 * 1000);
cleanupTimer.unref();

async function shutdown(signal) {
  console.log(`${signal} received; shutting down.`);
  clearInterval(cleanupTimer);
  server.close(async (error) => {
    if (error) {
      console.error('HTTP server shutdown failed:', error);
      process.exitCode = 1;
    }
    await closeDatabase();
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
