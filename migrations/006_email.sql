-- 006_email.sql
-- Simulated outgoing email and single-use email action tokens.
--
-- SRS 3.2 and 4.6 allow simulations in the academic MVP. The outbox holds what a real
-- email provider would receive, while verification links prove account ownership before
-- a user becomes an organizer. Tokens are stored only as hashes and support both email
-- verification and the password reset flow.

ALTER TABLE users ADD COLUMN email_verified_at TIMESTAMPTZ;
-- Accounts that existed before verification was introduced count as verified.
UPDATE users SET email_verified_at = created_at;

CREATE TABLE email_outbox (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID REFERENCES users (id) ON DELETE SET NULL,
  to_email   TEXT NOT NULL,
  kind       TEXT NOT NULL,          -- e.g. 'verify_email'
  subject    TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX email_outbox_to_email_idx ON email_outbox (lower(to_email), created_at DESC);

CREATE TABLE email_tokens (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  purpose    TEXT NOT NULL CHECK (purpose IN ('verify_email', 'reset_password')),
  token_hash TEXT NOT NULL UNIQUE,  -- sha256 hex of the token; the token itself is never stored
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
