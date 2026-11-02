import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { SMTPServer } from 'smtp-server';

const testDataDir = await mkdtemp(path.join(tmpdir(), 'pg-stay-test-'));
const deliveredEmails = [];
const smtpServer = new SMTPServer({
  authOptional: true,
  disabledCommands: ['STARTTLS'],
  onData(stream, session, callback) {
    let message = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => { message += chunk; });
    stream.on('end', () => {
      deliveredEmails.push(message);
      callback();
    });
  },
});
await new Promise((resolve, reject) => {
  smtpServer.once('error', reject);
  smtpServer.listen(0, '127.0.0.1', resolve);
});
process.env.PGLITE_DATA_DIR = path.join(testDataDir, 'database', 'postgres');
process.env.JWT_SECRET = 'test-secret-with-more-than-thirty-two-characters';
process.env.ADMIN_BOOTSTRAP_KEY = 'test-bootstrap-key-with-more-than-thirty-two-characters';
process.env.SMTP_HOST = '127.0.0.1';
process.env.SMTP_PORT = String(smtpServer.server.address().port);
process.env.SMTP_SECURE = 'false';
process.env.EMAIL_FROM = 'PG Stay Test <noreply@example.com>';
process.env.APP_BASE_URL = 'http://localhost:5173';
process.env.CORS_ORIGINS = 'http://localhost:5173,http://127.0.0.1:5173';
delete process.env.SMTP_USER;
delete process.env.SMTP_PASSWORD;

const { default: app } = await import('../src/app.js');
const { closeDatabase, migrate } = await import('../src/db.js');
await migrate();

after(async () => {
  await closeDatabase();
  await new Promise((resolve) => smtpServer.close(resolve));
  await rm(testDataDir, { recursive: true, force: true });
});

test('health endpoint responds', async () => {
  const response = await request(app).get('/health');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { status: 'ok' });
});

test('Swagger JSON and interactive UI are served', async () => {
  const specification = await request(app).get('/api-docs.json');
  assert.equal(specification.status, 200);
  assert.equal(specification.body.openapi, '3.0.3');
  assert.equal(specification.body.info.title, 'Giriraj Boys PG API');
  assert.ok(specification.body.paths['/api/inquiries']);
  assert.ok(specification.body.paths['/api/auth/password/forgot']);
  assert.ok(specification.body.paths['/api/auth/password/reset']);
  assert.equal(specification.body.servers[0].url, '/');

  const ui = await request(app).get('/api-docs/');
  assert.equal(ui.status, 200);
  assert.match(ui.text, /id="swagger-ui"/);
});

test('only REST API and Swagger routes are exposed; frontend origins are allow-listed', async () => {
  const preflight = await request(app)
    .options('/api/reviews')
    .set('Origin', 'http://localhost:5173')
    .set('Access-Control-Request-Method', 'POST')
    .set('Access-Control-Request-Headers', 'authorization,content-type');
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers['access-control-allow-origin'], 'http://localhost:5173');
  assert.match(preflight.headers['access-control-allow-headers'], /authorization/i);

  const untrusted = await request(app)
    .get('/api/reviews')
    .set('Origin', 'https://untrusted.example');
  assert.equal(untrusted.headers['access-control-allow-origin'], undefined);

  for (const route of ['/', '/index.html', '/styles.css', '/app.js', '/reset-password.html']) {
    const response = await request(app).get(route);
    assert.equal(response.status, 404, `${route} should not serve a frontend page`);
    assert.equal(response.headers['content-type'].split(';')[0], 'application/json');
  }

  const urlEncoded = await request(app)
    .post('/api/inquiries')
    .type('form')
    .send({ name: 'Riya Sharma', email: 'riya@example.com' });
  assert.notEqual(urlEncoded.status, 201);
});

test('complete user, inquiry, moderation, and admin flow uses PostgreSQL', async () => {
  const bootstrap = await request(app)
    .post('/api/auth/admin/bootstrap')
    .set('X-Admin-Bootstrap-Key', process.env.ADMIN_BOOTSTRAP_KEY)
    .send({
      name: 'Site Admin',
      email: 'admin@example.com',
      password: 'An-Admin-Password-123',
    });
  assert.equal(bootstrap.status, 201);
  const adminToken = bootstrap.body.accessToken;
  const adminHeaders = { Authorization: `Bearer ${adminToken}` };

  const secondBootstrap = await request(app)
    .post('/api/auth/admin/bootstrap')
    .set('X-Admin-Bootstrap-Key', process.env.ADMIN_BOOTSTRAP_KEY)
    .send({
      name: 'Second Admin',
      email: 'second-admin@example.com',
      password: 'Another-Admin-Password-123',
    });
  assert.equal(secondBootstrap.status, 409);

  const inquiry = await request(app).post('/api/inquiries').send({
    name: 'Riya Sharma',
    email: 'RIYA@example.com',
    phone: '+91-9876543210',
    message: 'Please tell me about available rooms for December.',
  });
  assert.equal(inquiry.status, 201);
  assert.equal(inquiry.body.inquiry.email, 'riya@example.com');
  assert.ok(new Date(inquiry.body.inquiry.expires_at) > new Date());
  const retentionWindow = new Date(inquiry.body.inquiry.expires_at)
    - new Date(inquiry.body.inquiry.created_at);
  assert.ok(Math.abs(retentionWindow - 30 * 24 * 60 * 60 * 1000) < 1000);

  const inquiryPage = await request(app)
    .get('/api/inquiries')
    .set(adminHeaders);
  assert.equal(inquiryPage.status, 200);
  assert.equal(inquiryPage.body.inquiries.length, 1);
  const inquiryId = inquiry.body.inquiry.id;

  const forbidden = await request(app)
    .get('/api/inquiries')
    .set('Authorization', 'Bearer invalid');
  assert.equal(forbidden.status, 401);

  const registration = await request(app).post('/api/auth/register').send({
    name: 'Asha Kumar',
    email: 'asha@example.com',
    password: 'A-strong-password-123',
  });
  assert.equal(registration.status, 201);
  const userToken = registration.body.accessToken;
  const userHeaders = { Authorization: `Bearer ${userToken}` };
  const { default: pool } = await import('../src/db.js');
  const accountRetention = await pool.query(
    'SELECT expires_at FROM users WHERE id = $1',
    [registration.body.user.id],
  );
  const accountRetentionWindow = new Date(accountRetention.rows[0].expires_at) - new Date();
  assert.ok(Math.abs(accountRetentionWindow - 30 * 24 * 60 * 60 * 1000) < 1000);

  const me = await request(app).get('/api/auth/me').set(userHeaders);
  assert.equal(me.status, 200);
  assert.equal(me.body.user.role, 'user');

  const deniedAdminAccess = await request(app)
    .get('/api/inquiries')
    .set(userHeaders);
  assert.equal(deniedAdminAccess.status, 403);

  const submittedReview = await request(app)
    .post('/api/reviews')
    .set(userHeaders)
    .send({ rating: 5, comment: 'Clean rooms and a very helpful team.' });
  assert.equal(submittedReview.status, 201);
  assert.equal(submittedReview.body.review.status, 'pending');
  const reviewId = submittedReview.body.review.id;

  const publicBeforeApproval = await request(app).get('/api/reviews');
  assert.equal(publicBeforeApproval.body.reviews.length, 0);

  const approvedReview = await request(app)
    .patch(`/api/admin/reviews/${reviewId}/status`)
    .set(adminHeaders)
    .send({ status: 'approved' });
  assert.equal(approvedReview.status, 200);

  const publicAfterApproval = await request(app).get('/api/reviews');
  assert.equal(publicAfterApproval.body.reviews.length, 1);
  assert.equal(publicAfterApproval.body.reviews[0].author, 'Asha Kumar');

  const oldUserToken = userHeaders.Authorization;
  const forgotPassword = await request(app)
    .post('/api/auth/password/forgot')
    .send({ email: 'asha@example.com' });
  assert.equal(forgotPassword.status, 202);
  assert.equal(deliveredEmails.length, 1);
  assert.match(deliveredEmails[0], /asha@example\.com/i);
  const decodedEmail = deliveredEmails[0]
    .replace(/=\r?\n/g, '')
    .replace(/=3D/gi, '=');
  const resetToken = decodedEmail.match(
    /\/reset-password\?token=([A-Za-z0-9_-]+)/,
  )?.[1];
  assert.ok(resetToken, 'reset email points to the frontend reset route and includes a token');
  assert.equal(resetToken.length, 43);

  const storedReset = await pool.query(
    'SELECT token_hash, expires_at FROM password_reset_tokens WHERE user_id = $1',
    [registration.body.user.id],
  );
  assert.notEqual(storedReset.rows[0].token_hash.trim(), resetToken);
  assert.ok(new Date(storedReset.rows[0].expires_at) > new Date());

  const resetPassword = await request(app)
    .post('/api/auth/password/reset')
    .send({ token: resetToken, password: 'A-new-strong-password-123' });
  assert.equal(resetPassword.status, 200, JSON.stringify(resetPassword.body));
  const replayedToken = await request(app)
    .post('/api/auth/password/reset')
    .send({ token: resetToken, password: 'Another-new-password-123' });
  assert.equal(replayedToken.status, 400);
  const revokedToken = await request(app)
    .get('/api/auth/me')
    .set('Authorization', oldUserToken);
  assert.equal(revokedToken.status, 401);
  const obsoletePassword = await request(app)
    .post('/api/auth/login')
    .send({ email: 'asha@example.com', password: 'A-strong-password-123' });
  assert.equal(obsoletePassword.status, 401);
  const newPasswordLogin = await request(app)
    .post('/api/auth/login')
    .send({ email: 'asha@example.com', password: 'A-new-strong-password-123' });
  assert.equal(newPasswordLogin.status, 200);
  userHeaders.Authorization = `Bearer ${newPasswordLogin.body.accessToken}`;

  const unknownAccountReset = await request(app)
    .post('/api/auth/password/forgot')
    .send({ email: 'not-registered@example.com' });
  assert.equal(unknownAccountReset.status, 202);
  assert.equal(deliveredEmails.length, 1);
  const smtpHost = process.env.SMTP_HOST;
  delete process.env.SMTP_HOST;
  const smtpMissing = await request(app)
    .post('/api/auth/password/forgot')
    .send({ email: 'asha@example.com' });
  assert.equal(smtpMissing.status, 503);
  assert.equal(smtpMissing.body.error.code, 'EMAIL_NOT_CONFIGURED');
  process.env.SMTP_HOST = smtpHost;

  const updateInquiry = await request(app)
    .put(`/api/inquiries/${inquiryId}`)
    .set(adminHeaders)
    .send({
      name: 'Riya Sharma',
      email: 'riya@example.com',
      phone: '+91-9876543210',
      message: 'Please contact me about an available single room.',
    });
  assert.equal(updateInquiry.status, 200);
  assert.equal(
    updateInquiry.body.inquiry.expires_at,
    inquiry.body.inquiry.expires_at,
  );
  await pool.query(
    "UPDATE inquiries SET expires_at = NOW() - INTERVAL '1 second' WHERE id = $1",
    [inquiryId],
  );
  const expiredInquiryPage = await request(app)
    .get('/api/inquiries')
    .set(adminHeaders);
  assert.equal(expiredInquiryPage.body.inquiries.length, 0);

  const disabled = await request(app)
    .patch(`/api/admin/users/${registration.body.user.id}/disable`)
    .set(adminHeaders)
    .send({ disabled: true });
  assert.equal(disabled.status, 200);
  const disabledAccount = await request(app).get('/api/auth/me').set(userHeaders);
  assert.equal(disabledAccount.status, 401);

  const deletedReview = await request(app)
    .delete(`/api/admin/reviews/${reviewId}`)
    .set(adminHeaders);
  assert.equal(deletedReview.status, 204);
  const deletedInquiry = await request(app)
    .delete(`/api/inquiries/${inquiryId}`)
    .set(adminHeaders);
  assert.equal(deletedInquiry.status, 204);
});

test('30-day cleanup handles 305 accounts and inquiries without deleting admins or reviews', async () => {
  const { default: pool, cleanupExpiredData } = await import('../src/db.js');
  const { issueToken } = await import('../src/auth.js');
  const expiredUsers = await pool.query(
    `INSERT INTO users (name, email, password_hash, role, expires_at)
     SELECT 'Resident ' || n, 'resident-' || n || '@example.com', 'unused-test-hash',
            'user', NOW() + INTERVAL '29 days'
     FROM generate_series(1, 305) AS n
     RETURNING id`,
  );
  const review = await pool.query(
    `INSERT INTO reviews (user_id, author_name, rating, comment, status)
     VALUES ($1, 'Resident 1', 5, 'Please keep this review after account expiry.', 'approved')
     RETURNING id`,
    [expiredUsers.rows[0].id],
  );
  await pool.query(
    `INSERT INTO inquiries (name, email, phone, message, created_at, updated_at, expires_at)
     SELECT 'Resident ' || n, 'resident-' || n || '@example.com', '+91-9876543210',
            'Expired test inquiry record.', NOW() - INTERVAL '31 days',
            NOW() - INTERVAL '31 days', NOW() - INTERVAL '1 day'
     FROM generate_series(1, 305) AS n`,
  );
  await pool.query(
    `INSERT INTO inquiries (name, email, phone, message)
     VALUES ('Current resident', 'current@example.com', '+91-9876543210',
             'This recent inquiry must be kept.')`,
  );

  const { rows: admins } = await pool.query("SELECT id, auth_version FROM users WHERE role = 'admin'");
  const adminToken = issueToken({ id: admins[0].id, role: 'admin', auth_version: admins[0].auth_version });
  const userPageSizes = [];
  for (const offset of [0, 100, 200, 300]) {
    const page = await request(app)
      .get(`/api/admin/users?limit=100&offset=${offset}`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(page.status, 200);
    userPageSizes.push(page.body.users.length);
  }
  assert.deepEqual(userPageSizes, [100, 100, 100, 6]);

  await pool.query(
    `UPDATE users
     SET expires_at = NOW() - INTERVAL '31 days', disabled_at = NULL
     WHERE role = 'user'`,
  );
  const expiredUser = await pool.query(
    "SELECT id, auth_version FROM users WHERE email = 'asha@example.com'",
  );
  const expiredToken = issueToken({
    id: expiredUser.rows[0].id,
    role: 'user',
    auth_version: expiredUser.rows[0].auth_version,
  });
  const expiredAccountAccess = await request(app)
    .get('/api/auth/me')
    .set('Authorization', `Bearer ${expiredToken}`);
  assert.equal(expiredAccountAccess.status, 401);
  assert.equal(expiredAccountAccess.body.error.code, 'ACCOUNT_EXPIRED');
  const cleanup = await cleanupExpiredData();
  assert.equal(cleanup.users, 306);
  assert.equal(cleanup.inquiries, 305);
  const adminCount = await pool.query("SELECT COUNT(*)::int AS count FROM users WHERE role = 'admin'");
  assert.equal(adminCount.rows[0].count, 1);
  const adminExpiry = await pool.query("SELECT expires_at FROM users WHERE role = 'admin'");
  assert.equal(adminExpiry.rows[0].expires_at, null);
  const remainingUsers = await pool.query("SELECT COUNT(*)::int AS count FROM users WHERE role = 'user'");
  assert.equal(remainingUsers.rows[0].count, 0);
  const keptReview = await pool.query(
    'SELECT user_id, author_name, comment, status FROM reviews WHERE id = $1',
    [review.rows[0].id],
  );
  assert.equal(keptReview.rows[0].user_id, null);
  assert.equal(keptReview.rows[0].author_name, 'Former resident');
  assert.equal(keptReview.rows[0].comment, 'Please keep this review after account expiry.');
  assert.equal(keptReview.rows[0].status, 'approved');
  const remainingInquiries = await pool.query('SELECT COUNT(*)::int AS count FROM inquiries');
  assert.equal(remainingInquiries.rows[0].count, 1);
});

test('malformed JSON receives a client error', async () => {
  const response = await request(app)
    .post('/api/inquiries')
    .set('Content-Type', 'application/json')
    .send('{"name":');
  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'INVALID_JSON');
});
