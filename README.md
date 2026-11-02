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

`npm run setup` writes a `.env` file with unique private signing, owner-control, and cron secrets. It never overwrites an existing `.env`. Starting the server automatically creates/updates the database schema and removes expired password-reset tokens. The local database is persisted under `data/postgres/`.

- Swagger UI: <http://localhost:3000/api-docs/>
- OpenAPI JSON: <http://localhost:3000/api-docs.json>
- Health JSON: <http://localhost:3000/health>

The root URL returns API links; it does not serve the React frontend. Frontend asset paths return JSON 404 responses. Stop the server with Ctrl+C. For production or multiple backend instances, use managed PostgreSQL by setting `DATABASE_URL` in the hosting provider's environment; startup automatically applies migrations.

## Deploy to Vercel

Vercel detects the default-exported Express app in `src/app.js` and serves its routes through one serverless function. Vercel's filesystem is ephemeral, so the embedded PostgreSQL database is intentionally rejected there; configure a managed PostgreSQL database before deploying.

1. Import this repository into Vercel with the repository root as the project root. Keep the Node.js version at 20 or newer.
2. Create a managed PostgreSQL database and add its connection string as `DATABASE_URL` for the Vercel environments you will deploy. If your Vercel database integration supplies `POSTGRES_URL` instead, the backend accepts that variable too. Include the provider-required SSL option in the URL (commonly `?sslmode=require`).
3. Add these Vercel environment variables:
   - `JWT_SECRET`: a private random secret of at least 32 characters.
   - `CRON_SECRET`: a private random secret of at least 32 characters; Vercel uses it to authorize scheduled cleanup of expired password-reset tokens.
   - `CORS_ORIGINS`: the exact deployed React frontend origin, including `https://` and no path. Multiple origins can be comma-separated.
4. Deploy. The Vercel build validates the environment, applies migrations, and fails clearly if configuration or the database is unavailable.
5. Create or recover the administrator only through the owner CLI below. There is no public admin-creation or admin-password-reset endpoint.

For password-reset email, also configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `EMAIL_FROM`, and `APP_BASE_URL` as described below. The local `data/postgres/` directory is excluded from Vercel deployments; production data belongs in the managed database.

If a deployment shows `FUNCTION_INVOCATION_FAILED`, check its Vercel runtime logs for the startup error. The required database and secrets must be set for the deployed environment, then the project must be redeployed after changing environment variables. A successful build logs that migrations completed; test `/health` and `/api-docs/` on the deployed URL.

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

## Owner-controlled administrator credentials

Public registration only creates regular users. Admin credentials can only be created or changed by running the private CLI from a trusted machine with database access. `OWNER_CONTROL_KEY` is a private secret in the operator's local `.env`; do not add it to Vercel's runtime environment. For a new local setup, `npm run setup` creates it. If `.env` already exists, add a newly generated value (for example, `node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"`) rather than replacing your existing secrets. When managing a remote deployment, provide the production `DATABASE_URL` to this local command. Passwords are prompted interactively and are never returned by an API.

```powershell
npm run admin -- create
npm run admin -- change-email
npm run admin -- reset-password
```

The CLI validates the owner key, enforces one admin account, and revokes existing sessions after changing credentials. To recover a forgotten admin password, run `npm run admin -- reset-password` on a trusted machine with access to the same database. Admin password-reset requests through the public forgot-password flow are deliberately ignored. Admin API routes require a valid bearer token and the database-backed admin role. Log out with `POST /api/auth/logout`; access tokens also expire after 15 minutes.

Open Swagger at `/api-docs/`, log in using `POST /api/auth/login`, and authorize with the returned access token to try admin operations.

In Swagger, expand an operation, select **Try it out**, enter the shown JSON example, and click **Execute**. The description at the top explains the owner-managed administrator and user/review workflows. The OpenAPI document has request/response examples and schemas for the API endpoints.

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
| `POST` | `/api/auth/register` | Public | Register a regular account |
| `POST` | `/api/auth/login` | Public | Sign in |
| `POST` | `/api/auth/logout` | Signed in | Revoke account sessions |
| `POST` | `/api/auth/password/forgot` | Public + SMTP | Send a reset email |
| `POST` | `/api/auth/password/reset` | Public + reset token | Set a new password |
| `GET` | `/api/auth/me` | Signed in | Read current account |
| `POST` | `/api/inquiries` | Public | Submit a contact enquiry |
| `GET`, `GET /:id`, `PUT /:id`, `PATCH /:id/status`, `DELETE /:id` | `/api/inquiries` | Admin | Search, manage, and permanently delete submissions |
| `GET` | `/api/reviews` | Public | List approved reviews |
| `POST` | `/api/reviews` | Public | Submit a review for moderation |
| `PUT`, `DELETE` | `/api/reviews/:id` | Owner or admin | Edit/delete a review |
| `GET` | `/api/admin/reviews` | Admin | List/filter review queue |
| `PATCH` | `/api/admin/reviews/:id/status` | Admin | Approve or reject a review |
| `DELETE` | `/api/admin/reviews/:id` | Admin | Delete a review |
| `GET` | `/api/admin/users` | Admin | List all regular accounts |
| `PATCH` | `/api/admin/users/:id/disable` | Admin | Disable/re-enable an account |

List endpoints accept `limit` (1–100, default 20) and `offset` (default 0).

## Data retention and security

- User accounts, inquiries, and reviews are not automatically expired or deleted. Only an authenticated admin can delete inquiry or review records. Keep managed PostgreSQL backups enabled and test restores; hosting deployments do not provide durable database storage.
- Inquiry administration supports `q` searches across name, email, phone, and message; `from`/`to` ISO timestamps; `status` (`new`, `contacted`, `resolved`); and `sort` (`newest`, `oldest`). Results are paginated and include a total count.
- Passwords use bcrypt hashing. Inputs are validated and SQL is parameterized. Admin routes require a live account lookup and admin role, not just a user-supplied role.
- JWTs expire after 15 minutes; logout and owner credential changes revoke active sessions. Admin credentials can only be changed through the owner-controlled CLI.
- Helmet, exact-origin CORS, payload limits, rate limits, JSON validation errors, and server-side error logging are enabled.
- The embedded PostgreSQL mode is for local/simple single-instance development. For deployment, use managed PostgreSQL, HTTPS, a strong secret manager, backups, SMTP provider credentials, and the exact React frontend origin in `CORS_ORIGINS`. Vercel builds fail unless `DATABASE_URL` (or `POSTGRES_URL`), `JWT_SECRET`, `CRON_SECRET`, and `CORS_ORIGINS` are configured.

The API does not include email verification or payment processing.
