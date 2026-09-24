-- 002_event_staff.sql
-- Who is allowed to scan tickets at the door of which event.
--
-- docs/api.md has GET /api/staff/events ("events I'm assigned to"), and 001 had no
-- table that could answer it: users.role says somebody is an event_admin, but not
-- which events are theirs. Without this table check-in would either see every event
-- or need a hardcoded rule.

-- ---------------------------------------------------------------------------
-- event_staff
-- ---------------------------------------------------------------------------
CREATE TABLE event_staff (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- CASCADE: an assignment has no meaning once the event is gone, and unlike tickets
  -- nobody paid for it.
  event_id    UUID NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Doc is silent: keeping who granted the access makes "why can this person scan?"
  -- answerable. SET NULL because the assignment stays valid if that account is removed.
  assigned_by UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One row per person per event. Assigning twice is not an error the API should
  -- have to think about: ON CONFLICT DO NOTHING against this constraint.
  CONSTRAINT event_staff_event_user_unique UNIQUE (event_id, user_id)
);

-- Doc is silent: the database does not check that user_id has role 'event_admin'.
-- Roles change over time and an organizer may want to scan at their own door, so the
-- endpoint decides who may be assigned. This table only answers "is this person on
-- the door of this event?".

-- The door scans by event: "give me the staff of event X".
CREATE INDEX event_staff_event_id_idx ON event_staff (event_id);
-- The app opens on "my events": "give me the events of user Y".
CREATE INDEX event_staff_user_id_idx ON event_staff (user_id);
CREATE INDEX event_staff_assigned_by_idx ON event_staff (assigned_by);

CREATE TRIGGER event_staff_set_updated_at BEFORE UPDATE ON event_staff
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
