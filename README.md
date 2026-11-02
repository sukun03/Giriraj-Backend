# Giriraj Boys PG API

Standalone JSON REST backend for the separately developed Giriraj Boys PG React frontend. The backend does not serve landing pages, static frontend files, or frontend styling. Interactive API documentation is available at `/api-docs`.

## Run locally

Requirements: Node.js 20+ and npm. PostgreSQL does not need a separate installation for local development; the API uses persistent embedded PostgreSQL by default.

From this directory:

```powershell
npm install
npm run setup
npm start
```

`npm run setup` writes a `.env` file with unique private signing and administrator-bootstrap secrets. It never overwrites an existing `.env`. Starting the server automatically creates/updates the database schema and runs expired-data cleanup. The local database is persisted under `data/postgres/`.

- Swagger UI: <http://localhost:3000/api-docs/>
- OpenAPI JSON: <http://localhost:3000/api-docs.json>
- Health JSON: <http://localhost:3000/health>

Only REST API and Swagger routes are served by the backend; `/` and frontend asset paths return JSON 404 responses. Stop the server with Ctrl+C. For production or multiple backend instances, use managed PostgreSQL by setting `DATABASE_URL` in the hosting provider's environment; startup automatically applies migrations.

## Connect a separate React frontend with Axios

Install Axios in the React project:

```sh
npm install axios
```

Add the deployed backend URL to the React app's environment file (Vite example):

```dotenv
VITE_API_BASE_URL=http://localhost:3000
```

Create one reusable Axios client in the frontend:

```js
import axios from "axios";

export const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL,
  headers: { "Content-Type": "application/json" },
  timeout: 15000,
});

export function setAccessToken(token) {
  if (token) {
    api.defaults.headers.common.Authorization = `Bearer ${token}`;
  } else {
    delete api.defaults.headers.common.Authorization;
  }
}
```

Example public inquiry and review requests:

```js
import { api } from "./api";

const { data } = await api.post("/api/inquiries", {
  name: "Riya Sharma",
  email: "riya@example.com",
  phone: "+91-9876543210",
  message: "Please tell me about available rooms.",
});

const { data: reviewData } = await api.get("/api/reviews?limit=20&offset=0");
```

After login or registration, keep the returned `accessToken` in frontend memory and set it with `setAccessToken(accessToken)`. Call `setAccessToken(null)` on logout. The token expires after 15 minutes. Add the token returned by login to use protected endpoints; all data is JSON. For error handling, Axios throws on non-2xx responses, and the API response shape is `error: { code, message, details? }`.

### Configure frontend CORS

Set `CORS_ORIGINS` in the backend `.env` (local) or backend hosting environment (production) to a comma-separated allow-list of exact React website origins. Include scheme and port when present; do not include URL paths or use `*`.

```dotenv
# Local Vite development server
CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173

# Production example (use your real frontend domain)
# CORS_ORIGINS=https://girirajboyspg.example
```

Restart the backend after changing the allow-list. Production refuses to start without an explicit allow-list. The API permits JSON REST methods and the `Authorization` header; it does not enable cookie credentials. Do not configure Axios with `withCredentials` for this bearer-token API.

## Admin account and Swagger

There is no preset administrator email or password. Create the first admin once:

1. Open Swagger at `/api-docs/`, expand `POST /api/auth/admin/bootstrap`, and choose **Try it out**.
2. Copy `ADMIN_BOOTSTRAP_KEY` from the backend `.env` into the `X-Admin-Bootstrap-Key` header field.
3. Enter the admin name, email, and a private password of at least 12 characters. Execute the request.
4. Copy `accessToken` from the response, click Swagger's **Authorize** button, paste the token, and confirm.

Alternatively, log in with `POST /api/auth/login` and use the returned token. Admin bootstrap is permanently disabled after the first administrator exists. Passwords cannot be retrieved.

In Swagger, expand an operation, select **Try it out**, enter the shown JSON example, and click **Execute**. The description at the top explains the first-admin and user/review workflows. The OpenAPI document has request/response examples and schemas for every endpoint.

## Email and password reset

Configure credentials from a real email provider in the backend `.env` or hosting secret manager:

```dotenv
SMTP_HOST=smtp.your-email-provider.example
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-provider-smtp-username
SMTP_PASSWORD=your-provider-smtp-password
EMAIL_FROM=Giriraj Boys PG <no-reply@your-verified-domain.example>
APP_BASE_URL=http://localhost:5173
```

For production, `APP_BASE_URL` must be your React frontend's HTTPS origin and the sender domain must be verified with your provider. Keep SMTP credentials secret.

Call `POST /api/auth/password/forgot` with `{"email":"resident@example.com"}`. The email link opens the React route `/reset-password?token=...`; implement that route in React, extract the `token` query parameter, ask the resident for a new password, and call:

```js
await api.post("/api/auth/password/reset", { token, password: newPassword });
```

Reset tokens are single-use, expire after 30 minutes, and are stored hashed. Resetting a password invalidates the account's existing access tokens. The forgot-password endpoint uses the same response for existing and unknown accounts. It reports `503 EMAIL_NOT_CONFIGURED` until SMTP is set up.

## API endpoints

| Method | Path | Access | Purpose |
|---|---|---|---|
| `GET` | `/health` | Public | Health check |
| `POST` | `/api/auth/admin/bootstrap` | One-time bootstrap key | Create the first admin |
| `POST` | `/api/auth/register` | Public | Register a regular account |
| `POST` | `/api/auth/login` | Public | Sign in |
| `POST` | `/api/auth/password/forgot` | Public + SMTP | Send a reset email |
| `POST` | `/api/auth/password/reset` | Public + reset token | Set a new password |
| `GET` | `/api/auth/me` | Signed in | Read current account |
| `POST` | `/api/inquiries` | Public | Submit a contact enquiry |
| `GET`, `GET /:id`, `PUT /:id`, `DELETE /:id` | `/api/inquiries` | Admin | Manage enquiries |
| `GET` | `/api/reviews` | Public | List approved reviews |
| `POST` | `/api/reviews` | Signed in | Submit a review for moderation |
| `PUT`, `DELETE` | `/api/reviews/:id` | Owner or admin | Edit/delete a review |
| `GET` | `/api/admin/reviews` | Admin | List/filter review queue |
| `PATCH` | `/api/admin/reviews/:id/status` | Admin | Approve or reject a review |
| `DELETE` | `/api/admin/reviews/:id` | Admin | Delete a review |
| `GET` | `/api/admin/users` | Admin | List active regular accounts |
| `PATCH` | `/api/admin/users/:id/disable` | Admin | Disable/re-enable an account |

List endpoints accept `limit` (1–100, default 20) and `offset` (default 0).

## Data retention and security

- Regular accounts and contact enquiries expire 30 days after creation/submission. Cleanup runs at startup and hourly. Admin accounts never expire or get removed by cleanup.
- Reviews are never removed by retention cleanup. If their author account expires, the review stays and its author is anonymized as “Former resident.”
- Passwords use bcrypt hashing. Inputs are validated and SQL is parameterized. Admin routes require a live account lookup and admin role, not just a user-supplied role.
- JWTs expire after 15 minutes. Disabled or expired users and password-reset tokens cannot continue using old sessions.
- Helmet, exact-origin CORS, payload limits, rate limits, JSON validation errors, and server-side error logging are enabled.
- The embedded PostgreSQL mode is for local/simple single-instance development. For deployment, use managed PostgreSQL, HTTPS, a strong secret manager, backups, SMTP provider credentials, `NODE_ENV=production`, and the exact React frontend origin in `CORS_ORIGINS`.

The API does not include email verification or payment processing.
