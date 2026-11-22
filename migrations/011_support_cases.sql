-- 011_support_cases.sql
-- Contextual support cases and their asynchronous message threads (SRS 4.13, UC9).
--
-- A case is one of two kinds. An 'event' case is opened by a user with a paid order
-- for that event, with optional order and ticket context. A 'platform' case is opened
-- by an organizer about their account, activation, payment or technical problem and
-- deliberately has no event context. The API enforces access; the CHECK below keeps
-- the two shapes from being mixed up by a future writer.

-- ---------------------------------------------------------------------------
-- support_cases
-- ---------------------------------------------------------------------------
CREATE TABLE support_cases (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        TEXT NOT NULL CHECK (kind IN ('event', 'platform')),
  -- RESTRICT: a case is retained history after a person resolves it. An event with a
  -- paid order (the only kind an event case can be about) is already not deletable,
  -- so this costs nothing and stops a future cleanup from taking the thread with it.
  event_id    UUID REFERENCES events (id) ON DELETE RESTRICT,
  -- Context only. Both are optional because a case may be about the event in general,
  -- and RESTRICT because an order or ticket is a record people may need to discuss.
  order_id    UUID REFERENCES orders (id) ON DELETE RESTRICT,
  ticket_id   UUID REFERENCES tickets (id) ON DELETE RESTRICT,
  -- RESTRICT: the opener and the responders are part of the case history. Accounts
  -- are suspended or deactivated, never deleted.
  opened_by   UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  category    TEXT NOT NULL
              CHECK (category IN ('ticket_delivery', 'payment', 'refund', 'seating',
                                  'event_information', 'check_in', 'account', 'technical')),
  -- The same limits the API validates, so a bug in a future route cannot store an
  -- empty subject or a body-sized subject. char_length counts characters, not bytes.
  subject     TEXT NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 200),
  status      TEXT NOT NULL DEFAULT 'open'
              CHECK (status IN ('open', 'in_progress', 'waiting_for_customer', 'resolved')),
  -- NULL means nobody is assigned yet. The API checks that the person is a responder
  -- of this case; that relationship lives in two other tables, so it cannot be a
  -- foreign key here. SET NULL keeps the thread valid if the account is removed.
  assigned_to UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- An event case always names its event. A platform case never carries event, order
  -- or ticket context (the decided shape: account, activation, payment, technical).
  CONSTRAINT support_cases_event_context CHECK (
    (kind = 'event' AND event_id IS NOT NULL)
    OR (kind = 'platform' AND event_id IS NULL
        AND order_id IS NULL AND ticket_id IS NULL)
  )
);

CREATE TRIGGER support_cases_set_updated_at BEFORE UPDATE ON support_cases
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- "My cases as opener", newest activity first. The API also orders by the last
-- message, so this index narrows the rows before that sort.
CREATE INDEX support_cases_opened_by_created_at_idx
  ON support_cases (opened_by, created_at DESC);
-- "Cases about this event" for the organizer and staff view, and for event history.
CREATE INDEX support_cases_event_id_created_at_idx
  ON support_cases (event_id, created_at DESC);
-- "Cases assigned to me". Partial, because an unassigned case is nobody's queue.
CREATE INDEX support_cases_assigned_to_idx
  ON support_cases (assigned_to)
  WHERE assigned_to IS NOT NULL;
-- The list can filter by status for the responder's working queue.
CREATE INDEX support_cases_status_created_at_idx
  ON support_cases (status, created_at DESC);

-- ---------------------------------------------------------------------------
-- support_messages
-- ---------------------------------------------------------------------------
CREATE TABLE support_messages (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- CASCADE: a message has no meaning without its case. Cases themselves are not
  -- deleted by the API, so in practice this fires only in a deliberate cleanup.
  case_id    UUID NOT NULL REFERENCES support_cases (id) ON DELETE CASCADE,
  -- RESTRICT: the thread is retained history, and an author is part of it.
  author_id  UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  -- 1 to 5000 characters, matching the API. Empty messages and accidental dumps of
  -- an entire log file are both refused here.
  body       TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 5000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The thread read is "all messages of case X, oldest first", and the list needs the
-- latest message per case for last_message_at.
CREATE INDEX support_messages_case_id_created_at_idx
  ON support_messages (case_id, created_at);
-- "What has this person written across cases?" for moderation, and the email target
-- lookups do not need it, but it is cheap on this small table.
CREATE INDEX support_messages_author_id_idx
  ON support_messages (author_id);
