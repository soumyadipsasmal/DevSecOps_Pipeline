-- Admin authentication, applied to the existing `users` table.
--
-- The project already stores site authors in `users` with a bcrypt
-- `password_hash`, so admin accounts live there too instead of in a second,
-- parallel identity table. This migration only adds columns and constraints; it
-- never drops or renames anything, so the public article queries keep working
-- untouched.
--
-- Safe to run repeatedly: every statement is guarded, and an existing
-- password_hash is never overwritten.
--
-- Apply with:
--   npm run migrate                       (from app/, uses the DB_* env vars)
--   psql -h ... -f database/schema-admin-auth.sql
--
-- Fresh Docker volumes pick it up automatically via docker-compose.yml
-- (docker-entrypoint-initdb.d/08-admin-auth.sql).

-- Administrator role. Only 'admin' may open /admin.
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS role VARCHAR(20) NOT NULL DEFAULT 'author';

-- Disabling an account both blocks sign-in and invalidates existing sessions,
-- because every request re-reads the row.
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;

-- Embedded in the session cookie. Logout increments it, which invalidates every
-- cookie already issued for the account instead of relying on expiry alone.
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMP WITH TIME ZONE;

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;

-- Role values are constrained in the database as well as in the service layer,
-- so a hand-edited row cannot introduce an unexpected privilege.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'users_role_check'
          AND conrelid = 'users'::regclass
    ) THEN
        ALTER TABLE users
            ADD CONSTRAINT users_role_check
            CHECK (role IN ('author', 'editor', 'admin'));
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'users_session_version_positive'
          AND conrelid = 'users'::regclass
    ) THEN
        ALTER TABLE users
            ADD CONSTRAINT users_session_version_positive
            CHECK (session_version >= 1);
    END IF;
END $$;

-- Sign-in scans only look at administrators that are still active.
CREATE INDEX IF NOT EXISTS idx_users_role_active ON users (role, is_active);