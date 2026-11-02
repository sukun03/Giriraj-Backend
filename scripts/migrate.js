import 'dotenv/config';
import { closeDatabase, migrate } from '../src/db.js';

try {
  await migrate();
  console.log('Database migration completed.');
} finally {
  await closeDatabase();
}
