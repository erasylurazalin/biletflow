-- 005_audit_log.sql
-- One audit log that every feature writes to.
--
-- SRS 7: "organizer and administrator actions shall be auditable". SRS 4.9: payment and
-- refund actions are recorded in an audit log. SRS 4.16: each event has an activity
-- timeline, and every entry has a timestamp, acting user, action type, affected entity
-- and short description. This table is that timeline's storage; the endpoint that reads
-- it comes with the event history task.
--
-- Rows are written with recordAudit() from src/lib/audit.ts, inside the same
-- transaction as the action they describe. The list of action names lives in the
-- "Audit log" section of docs/api.md.

-- ---------------------------------------------------------------------------
-- audit_log
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- NULL means the system did it (an order expiring, say), not a person.
  -- RESTRICT: users are deactivated, never deleted, and the trigger below would refuse
  -- the SET NULL anyway.
  actor_id    UUID REFERENCES users (id) ON DELETE RESTRICT,
  -- Dotted names like 'event.published'. The full list is in docs/api.md and in
  -- AUDIT_ACTIONS in src/lib/audit.ts. The database only checks the shape, so a new
  -- action needs no migration.
  action      TEXT NOT NULL CHECK (action ~ '^[a-z_]+\.[a-z_]+$'),
  entity_type TEXT NOT NULL CHECK (entity_type ~ '^[a-z_]+$'),
  -- No foreign keys on entity_id and event_id, on purpose: the entry has to outlive
  -- what it describes. "Draft event deleted" is exactly the kind of entry that would
  -- otherwise vanish together with the event.
  entity_id   UUID NOT NULL,
  -- Set whenever the action belongs to an event, so the timeline is one query. NULL for
  -- actions on no particular event, like an organizer's identity check.
  event_id    UUID,
  description TEXT NOT NULL CHECK (char_length(description) BETWEEN 1 AND 500)
);

-- The event timeline: "everything on event X, newest first", filtered by date range.
CREATE INDEX audit_log_event_id_created_at_idx ON audit_log (event_id, created_at);
-- Admin moderation: "what did this user do?".
CREATE INDEX audit_log_actor_id_idx ON audit_log (actor_id);

-- Append only (SRS 4.16: "audit entries shall not be editable or deletable"). There is
-- no update or delete route, and this makes sure no future query does it by accident
-- either. Fixing a wrong entry means writing a new one.
CREATE FUNCTION audit_log_reject_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % is not allowed', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_no_update_or_delete BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_reject_change();

CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_reject_change();
