import { randomBytes } from 'node:crypto';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';

const envPath = resolve('.env');
const jwtSecret = randomBytes(48).toString('hex');
const bootstrapKey = randomBytes(48).toString('hex');
const contents = [
  'NODE_ENV=development',
  'PORT=3000',
  `JWT_SECRET=${jwtSecret}`,
  `ADMIN_BOOTSTRAP_KEY=${bootstrapKey}`,
  'CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173',
  '',
].join('\n');

try {
  const file = await open(envPath, 'wx', 0o600);
  await file.writeFile(contents, 'utf8');
  await file.close();
} catch (error) {
  if (error.code === 'EEXIST') {
    throw new Error('.env already exists. It was left unchanged; remove it yourself only if you intend to regenerate your secrets.');
  }
  throw error;
}

console.log('Created .env with unique JWT and admin bootstrap secrets.');
console.log('The one-time admin bootstrap key is stored in .env. Keep it private.');
console.log('Start the API with: npm start');
