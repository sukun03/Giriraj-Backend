DROP INDEX IF EXISTS inquiries_expires_idx;
ALTER TABLE inquiries DROP COLUMN IF EXISTS expires_at;

ALTER TABLE users DROP COLUMN IF EXISTS expires_at;

ALTER TABLE inquiries
ADD COLUMN IF NOT EXISTS status VARCHAR(12) NOT NULL DEFAULT 'new';

ALTER TABLE inquiries
ADD COLUMN IF NOT EXISTS form_data JSONB NOT NULL DEFAULT '{}'::jsonb;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'inquiries_status_check'
          AND conrelid = 'inquiries'::regclass
    ) THEN
        ALTER TABLE inquiries
        ADD CONSTRAINT inquiries_status_check
        CHECK (status IN ('new', 'contacted', 'resolved'));
    END IF;
END
$$;

CREATE INDEX IF NOT EXISTS inquiries_status_created_idx
ON inquiries (status, created_at DESC);

ALTER TABLE reviews ADD COLUMN IF NOT EXISTS author_email VARCHAR(254);

CREATE UNIQUE INDEX IF NOT EXISTS users_single_admin_idx
ON users (role)
WHERE role = 'admin';
