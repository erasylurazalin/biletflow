-- 010_event_suspension.sql
-- Platform admins can suspend an event (SRS 4.12, success criterion 12).
--
-- Suspension is a separate flag, not a fourth value of events.status. The status says
-- where the organizer has taken the event (draft, published, cancelled); suspension is
-- the platform stepping in on top of it. Keeping them apart means lifting a suspension
-- puts the event back exactly as it was, with nothing to remember or guess.
--
-- A suspended event is left out of the public list and detail and takes no new orders.
-- Existing orders and tickets are untouched.

ALTER TABLE events
  ADD COLUMN suspended_at TIMESTAMPTZ,
  -- RESTRICT like the other records of an admin action: who did it must stay answerable.
  ADD COLUMN suspended_by UUID REFERENCES users (id) ON DELETE RESTRICT,
  -- Both set or both empty, so a suspension always says who made it.
  ADD CONSTRAINT events_suspension_has_actor
    CHECK ((suspended_at IS NULL) = (suspended_by IS NULL));
