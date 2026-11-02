import 'dotenv/config';
import { timingSafeEqual } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const operations = new Set(['create', 'change-email', 'reset-password']);
const operation = process.argv[2];
if (!operations.has(operation)) {
  throw new Error('Choose an operation: create, change-email, or reset-password.');
}

const ownerControlKey = process.env.OWNER_CONTROL_KEY;
if (!ownerControlKey || ownerControlKey.length < 32) {
  throw new Error('Set OWNER_CONTROL_KEY to a private secret of at least 32 characters.');
}
if (!stdin.isTTY || !stdout.isTTY) {
  throw new Error('Administrator credential management requires an interactive terminal.');
}

const prompt = createInterface({ input: stdin, output: stdout });
let closeDatabase;

try {
  const providedKey = await prompt.question('Owner control key: ');
  const expected = Buffer.from(ownerControlKey);
  const provided = Buffer.from(providedKey);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new Error('Owner control key is invalid.');
  }

  const database = await import('../src/db.js');
  closeDatabase = database.closeDatabase;
  const { migrate } = database;
  const {
    changeAdminEmail,
    createAdminAccount,
    resetAdminPassword,
  } = await import('../src/admin-credentials.js');
  await migrate();
  if (operation === 'create') {
    await createAdminAccount({
      name: await prompt.question('Administrator name: '),
      email: await prompt.question('Administrator email: '),
      password: await prompt.question('Administrator password (12+ characters): '),
    });
  } else if (operation === 'change-email') {
    await changeAdminEmail(await prompt.question('New administrator email: '));
  } else {
    await resetAdminPassword(
      await prompt.question('New administrator password (12+ characters): '),
    );
  }
  console.log('Administrator credentials updated. Sign in with the new credentials.');
} finally {
  prompt.close();
  if (closeDatabase) {
    await closeDatabase();
  }
}
