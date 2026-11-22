-- 012_admin.sql
-- The rest of the administration portal (SRS 2.1, 4.5, 4.12, issue #63):
-- suspended users, reported events and the platform-wide activation fee setting.
--
-- This builds on migration 010, which added event suspension. Account suspension is a
-- separate flag on users, like event suspension is on events: it does not delete the
-- account or change its role, and lifting it puts the account back exactly as it was.
-- A suspended user's login is refused from that moment; an already-issued JWT keeps
-- working until it expires, because requireAuth deliberately does not read the database
-- (docs/decisions.md, decision 15).

-- ---------------------------------------------------------------------------
-- users: account suspension
-- ---------------------------------------------------------------------------
ALTER TABLE users
  ADD COLUMN suspended_at TIMESTAMPTZ,
  -- RESTRICT like the other records of an admin action: who did it must stay answerable.
  ADD COLUMN suspended_by UUID REFERENCES users (id) ON DELETE RESTRICT,
  -- Both set or both empty, so a suspension always says who made it.
  ADD CONSTRAINT users_suspension_has_actor
    CHECK ((suspended_at IS NULL) = (suspended_by IS NULL));

-- Admin search is "email or name contains", case-insensitively. A trigram index would
-- be the textbook answer, but the academic MVP's table is tiny and pg_trgm is not
-- installed by default. The lower() indexes already used by login still help exact email
-- lookups; this one makes the list filter cheap enough.
CREATE INDEX users_name_lower_idx ON users (lower(name));
CREATE INDEX users_suspended_at_idx ON users (suspended_at);

-- ---------------------------------------------------------------------------
-- event_reports: attendees reporting a published event
-- ---------------------------------------------------------------------------
CREATE TABLE event_reports (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- CASCADE: a report has no meaning without its event. Events are financial records
  -- for orders, but a report is only moderation history, and the audit log keeps the
  -- lasting statement that a decision was made.
  event_id    UUID NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  -- RESTRICT: a report must keep saying who made it.
  reported_by UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  reason      TEXT NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 1000),
  status      TEXT NOT NULL DEFAULT 'open'
              CHECK (status IN ('open', 'dismissed', 'actioned')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Both set when an admin dismisses the report or suspends its event.
  reviewed_by UUID REFERENCES users (id) ON DELETE RESTRICT,
  reviewed_at TIMESTAMPTZ,
  -- A review is both fields or neither, so a decision always says who made it and when.
  CONSTRAINT event_reports_review_has_actor
    CHECK ((reviewed_at IS NULL) = (reviewed_by IS NULL))
);

CREATE INDEX event_reports_event_id_idx ON event_reports (event_id);
CREATE INDEX event_reports_reported_by_idx ON event_reports (reported_by);
CREATE INDEX event_reports_status_created_at_idx ON event_reports (status, created_at);

-- One OPEN report per user per event. A closed report (dismissed or actioned) does not
-- block a later report by the same person, which is the point of the partial index.
CREATE UNIQUE INDEX event_reports_one_open_per_user_idx
  ON event_reports (event_id, reported_by)
  WHERE status = 'open';

-- ---------------------------------------------------------------------------
-- platform_settings: one row of platform-wide configuration
-- ---------------------------------------------------------------------------
CREATE TABLE platform_settings (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- A unique boolean with only TRUE allowed makes "exactly one row" a database rule,
  -- while still giving audit_log an ordinary UUID entity id to point at.
  singleton      BOOLEAN NOT NULL DEFAULT TRUE UNIQUE CHECK (singleton),
  -- The paid-sales activation fee in tiyn. 500000 is 5,000 KZT, the old constant and
  -- the migration default from decisions 3 (SRS 3.3 leaves the amount open).
  activation_fee INTEGER NOT NULL DEFAULT 500000 CHECK (activation_fee >= 0),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by     UUID REFERENCES users (id) ON DELETE RESTRICT
);

CREATE TRIGGER platform_settings_set_updated_at BEFORE UPDATE ON platform_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The row exists from the first request, so GET and the paid-sales query never have to
-- fall back to a constant in code.
INSERT INTO platform_settings (activation_fee) VALUES (500000);
