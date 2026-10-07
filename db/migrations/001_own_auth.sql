-- 001_own_auth.sql
-- Adds web-authentication columns and password-reset table.
-- Safe to run multiple times (all statements use IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).

-- 1. password_hash and password_changed_at on users
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS password_hash        TEXT,
  ADD COLUMN IF NOT EXISTS password_changed_at  TIMESTAMPTZ;

-- 2. Unique index: one web account per normalised e-mail address.
--    Only covers rows that actually have a password (web accounts).
CREATE UNIQUE INDEX IF NOT EXISTS users_web_email_key
  ON users (lower(email))
  WHERE password_hash IS NOT NULL;

-- 3. password_resets table
CREATE TABLE IF NOT EXISTS password_resets (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT        NOT NULL UNIQUE,           -- SHA-256(random_token)
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS password_resets_user_id_idx
  ON password_resets (user_id);

CREATE INDEX IF NOT EXISTS password_resets_expires_at_idx
  ON password_resets (expires_at);
