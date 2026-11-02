ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

UPDATE users
SET expires_at = created_at + INTERVAL '30 days'
WHERE role = 'user' AND expires_at IS NULL;

UPDATE users SET expires_at = NULL WHERE role = 'admin';

CREATE INDEX IF NOT EXISTS users_expires_idx ON users (expires_at)
WHERE role = 'user';

CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash CHAR(64) NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS password_reset_expires_idx
ON password_reset_tokens (expires_at);

ALTER TABLE reviews ADD COLUMN IF NOT EXISTS author_name VARCHAR(100);

UPDATE reviews r
SET author_name = COALESCE(u.name, 'Former resident')
FROM users u
WHERE r.user_id = u.id AND r.author_name IS NULL;

UPDATE reviews SET author_name = 'Former resident' WHERE author_name IS NULL;

ALTER TABLE reviews ALTER COLUMN author_name SET DEFAULT 'Former resident';
ALTER TABLE reviews ALTER COLUMN author_name SET NOT NULL;
ALTER TABLE reviews ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE reviews DROP CONSTRAINT IF EXISTS reviews_user_id_fkey;
ALTER TABLE reviews
ADD CONSTRAINT reviews_user_id_fkey
FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
