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
process.env.OWNER_CONTROL_KEY = 'test-owner-key-with-more-than-thirty-two-characters';
process.env.CRON_SECRET = 'test-cron-secret-with-more-than-thirty-two-characters';
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

test('Vercel serverless entrypoint serves the Express application', async () => {
  const { default: handler } = await import('../src/app.js');
  assert.equal(handler, app);
  const response = await request(handler).get('/health');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { status: 'ok' });
});

test('scheduled cleanup requires its secret and removes expired data', async () => {
  const unauthorized = await request(app).get('/api/cron/cleanup');
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.body.error.code, 'INVALID_CRON_SECRET');

  const authorized = await request(app)
    .get('/api/cron/cleanup')
    .set('Authorization', `Bearer ${process.env.CRON_SECRET}`);
  assert.equal(authorized.status, 200);
  assert.equal(authorized.body.status, 'ok');
  assert.deepEqual(authorized.body.removed, { passwordResetTokens: 0 });
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
  const { createAdminAccount, changeAdminEmail, resetAdminPassword } =
    await import('../src/admin-credentials.js');
  await createAdminAccount({
    name: 'Site Admin',
    email: 'admin@example.com',
    password: 'An-Admin-Password-123',
  });
  const removedBootstrap = await request(app)
    .post('/api/auth/admin/bootstrap')
    .send({ name: 'Unauthorized Admin', email: 'unauthorized@example.com', password: 'Another-Password-123' });
  assert.equal(removedBootstrap.status, 404);
  const adminLogin = await request(app).post('/api/auth/login').send({
    email: 'admin@example.com',
    password: 'An-Admin-Password-123',
  });
  assert.equal(adminLogin.status, 200);
  const initialAdminToken = adminLogin.body.accessToken;
  const initialAdminHeaders = { Authorization: `Bearer ${initialAdminToken}` };

  await changeAdminEmail('owner@example.com');
  await resetAdminPassword('A-new-owner-password-123');
  const revokedAdminSession = await request(app)
    .get('/api/inquiries')
    .set(initialAdminHeaders);
  assert.equal(revokedAdminSession.status, 401);
  const adminResetRequest = await request(app)
    .post('/api/auth/password/forgot')
    .send({ email: 'owner@example.com' });
  assert.equal(adminResetRequest.status, 202);
  assert.equal(deliveredEmails.length, 0);
  const oldAdminLogin = await request(app).post('/api/auth/login').send({
    email: 'admin@example.com',
    password: 'An-Admin-Password-123',
  });
  assert.equal(oldAdminLogin.status, 401);

  const recoveredAdminLogin = await request(app).post('/api/auth/login').send({
    email: 'owner@example.com',
    password: 'A-new-owner-password-123',
  });
  assert.equal(recoveredAdminLogin.status, 200);
  assert.equal(Object.hasOwn(recoveredAdminLogin.body, 'password'), false);
  const adminToken = recoveredAdminLogin.body.accessToken;
  const adminHeaders = { Authorization: `Bearer ${adminToken}` };
  await assert.rejects(
    () => createAdminAccount({
      name: 'Second Admin',
      email: 'second-admin@example.com',
      password: 'Another-Admin-Password-123',
    }),
    { message: /administrator account already exists/i },
  );

  const invalidNestedFormField = await request(app).post('/api/inquiries').send({
    name: 'Riya Sharma',
    email: 'riya@example.com',
    phone: '+91-9876543210',
    message: 'Please tell me about available rooms for December.',
    roomDetails: { roomType: 'Single' },
  });
  assert.equal(invalidNestedFormField.status, 400);

  const inquiry = await request(app).post('/api/inquiries').send({
    name: 'Riya Sharma',
    email: 'RIYA@example.com',
    phone: '+91-9876543210',
    message: 'Please tell me about available rooms for December.',
    roomType: 'Single',
    occupants: 2,
    requestedAmenities: ['WiFi', 'Laundry'],
  });
  assert.equal(inquiry.status, 201);
  assert.equal(inquiry.body.inquiry.email, 'riya@example.com');
  assert.equal(inquiry.body.inquiry.status, 'new');
  assert.deepEqual(inquiry.body.inquiry.form_data, {
    roomType: 'Single',
    occupants: 2,
    requestedAmenities: ['WiFi', 'Laundry'],
  });
  assert.ok(new Date(inquiry.body.inquiry.created_at).getTime() > 0);

  const inquiryPage = await request(app)
    .get('/api/inquiries?q=Riya&status=new&sort=oldest')
    .set(adminHeaders);
  assert.equal(inquiryPage.status, 200);
  assert.equal(inquiryPage.body.inquiries.length, 1);
  assert.equal(inquiryPage.body.pagination.total, 1);
  const customFieldSearch = await request(app)
    .get('/api/inquiries?q=WiFi')
    .set(adminHeaders);
  assert.equal(customFieldSearch.body.pagination.total, 1);
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
  const userCreatedAt = await pool.query(
    'SELECT created_at FROM users WHERE id = $1',
    [registration.body.user.id],
  );
  assert.ok(new Date(userCreatedAt.rows[0].created_at).getTime() > 0);

  const me = await request(app).get('/api/auth/me').set(userHeaders);
  assert.equal(me.status, 200);
  assert.equal(me.body.user.role, 'user');

  const deniedAdminAccess = await request(app)
    .get('/api/inquiries')
    .set(userHeaders);
  assert.equal(deniedAdminAccess.status, 403);
  const attemptedAdminRegistration = await request(app).post('/api/auth/register').send({
    name: 'Public Admin',
    email: 'public-admin@example.com',
    password: 'A-public-admin-password-123',
    role: 'admin',
  });
  assert.equal(attemptedAdminRegistration.status, 400);

  const submittedReview = await request(app)
    .post('/api/reviews')
    .set(userHeaders)
    .send({ rating: 5, comment: 'Clean rooms and a very helpful team.' });
  assert.equal(submittedReview.status, 201);
  assert.equal(submittedReview.body.review.status, 'pending');
  const reviewId = submittedReview.body.review.id;
  const deniedReviewDeletion = await request(app)
    .delete(`/api/reviews/${reviewId}`)
    .set(userHeaders);
  assert.equal(deniedReviewDeletion.status, 403);
  const guestReview = await request(app).post('/api/reviews').send({
    name: 'Guest Reviewer',
    email: 'guest@example.com',
    rating: 4,
    comment: 'A clean and comfortable place to stay.',
  });
  assert.equal(guestReview.status, 201);
  assert.equal(guestReview.body.review.status, 'pending');
  assert.equal(Object.hasOwn(guestReview.body.review, 'author_email'), false);
  const missingGuestName = await request(app).post('/api/reviews').send({
    rating: 4,
    comment: 'A guest review without a reviewer name.',
  });
  assert.equal(missingGuestName.status, 400);
  const guestReviewId = guestReview.body.review.id;

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
  const approvedGuestReview = await request(app)
    .patch(`/api/admin/reviews/${guestReviewId}/status`)
    .set(adminHeaders)
    .send({ status: 'approved' });
  assert.equal(approvedGuestReview.status, 200);
  const publicReviews = await request(app).get('/api/reviews');
  assert.equal(publicReviews.body.reviews.length, 2);
  assert.equal(publicReviews.body.reviews.some((review) => 'author_email' in review), false);
  const privateReview = await request(app)
    .get('/api/admin/reviews?status=approved')
    .set(adminHeaders);
  assert.equal(privateReview.status, 200);
  assert.equal(
    privateReview.body.reviews.find((review) => review.id === guestReviewId).author_email,
    'guest@example.com',
  );

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
  assert.equal(updateInquiry.body.inquiry.created_at, inquiry.body.inquiry.created_at);
  const updatedInquiryStatus = await request(app)
    .patch(`/api/inquiries/${inquiryId}/status`)
    .set(adminHeaders)
    .send({ status: 'contacted' });
  assert.equal(updatedInquiryStatus.status, 200);
  assert.equal(updatedInquiryStatus.body.inquiry.status, 'contacted');
  const invalidInquiryStatus = await request(app)
    .patch(`/api/inquiries/${inquiryId}/status`)
    .set(adminHeaders)
    .send({ status: 'deleted' });
  assert.equal(invalidInquiryStatus.status, 400);
  const reversedDateFilter = await request(app)
    .get('/api/inquiries?from=2025-01-01T00:00:00.000Z&to=2024-01-01T00:00:00.000Z')
    .set(adminHeaders);
  assert.equal(reversedDateFilter.status, 400);

  const disabled = await request(app)
    .patch(`/api/admin/users/${registration.body.user.id}/disable`)
    .set(adminHeaders)
    .send({ disabled: true });
  assert.equal(disabled.status, 200);
  const disabledAccount = await request(app).get('/api/auth/me').set(userHeaders);
  assert.equal(disabledAccount.status, 401);
  const reenabled = await request(app)
    .patch(`/api/admin/users/${registration.body.user.id}/disable`)
    .set(adminHeaders)
    .send({ disabled: false });
  assert.equal(reenabled.status, 200);
  const revokedAfterReenable = await request(app)
    .get('/api/auth/me')
    .set(userHeaders);
  assert.equal(revokedAfterReenable.status, 401);

  const deletedReview = await request(app)
    .delete(`/api/admin/reviews/${reviewId}`)
    .set(adminHeaders);
  assert.equal(deletedReview.status, 204);
  const deletedInquiry = await request(app)
    .delete(`/api/inquiries/${inquiryId}`)
    .set(adminHeaders);
  assert.equal(deletedInquiry.status, 204);
  const logout = await request(app).post('/api/auth/logout').set(adminHeaders);
  assert.equal(logout.status, 204);
  const loggedOut = await request(app).get('/api/inquiries').set(adminHeaders);
  assert.equal(loggedOut.status, 401);
});

test('cleanup retains all old accounts, inquiries, and reviewer information', async () => {
  const { default: pool, cleanupExpiredData } = await import('../src/db.js');
  const { issueToken } = await import('../src/auth.js');
  const oldUsers = await pool.query(
    `INSERT INTO users (name, email, password_hash, role)
     SELECT 'Resident ' || n, 'resident-' || n || '@example.com', 'unused-test-hash',
            'user'
     FROM generate_series(1, 305) AS n
     RETURNING id`,
  );
  const review = await pool.query(
    `INSERT INTO reviews (user_id, author_name, author_email, rating, comment, status)
     VALUES ($1, 'Resident 1', 'resident-1@example.com', 5, 'Please keep this old review.', 'approved')
     RETURNING id`,
    [oldUsers.rows[0].id],
  );
  await pool.query(
    `INSERT INTO inquiries (name, email, phone, message, created_at, updated_at)
     SELECT 'Resident ' || n, 'resident-' || n || '@example.com', '+91-9876543210',
            'Long-term inquiry test record.', NOW() - INTERVAL '2 years',
            NOW() - INTERVAL '2 years'
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

  const oldest = new Date(Date.now() - 3 * 365 * 24 * 60 * 60 * 1000).toISOString();
  const newest = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
  const historicalSubmissions = await request(app)
    .get(`/api/inquiries?q=Long-term&status=new&sort=oldest&from=${encodeURIComponent(oldest)}&to=${encodeURIComponent(newest)}&limit=100`)
    .set('Authorization', `Bearer ${adminToken}`);
  assert.equal(historicalSubmissions.status, 200);
  assert.equal(historicalSubmissions.body.inquiries.length, 100);
  assert.equal(historicalSubmissions.body.pagination.total, 305);
  assert.ok(new Date(historicalSubmissions.body.inquiries[0].created_at) < new Date(newest));

  const cleanup = await cleanupExpiredData();
  assert.deepEqual(cleanup, { passwordResetTokens: 0 });
  const adminCount = await pool.query("SELECT COUNT(*)::int AS count FROM users WHERE role = 'admin'");
  assert.equal(adminCount.rows[0].count, 1);
  const remainingUsers = await pool.query("SELECT COUNT(*)::int AS count FROM users WHERE role = 'user'");
  assert.equal(remainingUsers.rows[0].count, 306);
  const keptReview = await pool.query(
    'SELECT user_id, author_name, author_email, comment, status FROM reviews WHERE id = $1',
    [review.rows[0].id],
  );
  assert.equal(keptReview.rows[0].user_id, oldUsers.rows[0].id);
  assert.equal(keptReview.rows[0].author_name, 'Resident 1');
  assert.equal(keptReview.rows[0].author_email, 'resident-1@example.com');
  assert.equal(keptReview.rows[0].comment, 'Please keep this old review.');
  assert.equal(keptReview.rows[0].status, 'approved');
  const remainingInquiries = await pool.query('SELECT COUNT(*)::int AS count FROM inquiries');
  assert.equal(remainingInquiries.rows[0].count, 306);
});

test('malformed JSON receives a client error', async () => {
  const response = await request(app)
    .post('/api/inquiries')
    .set('Content-Type', 'application/json')
    .send('{"name":');
  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'INVALID_JSON');
});
