-- 004_paid_sales.sql
-- Paid sales activation (SRS 3.2, 4.5, UC2) and simulated payments (SRS 4.6).
--
-- Free tickets need none of this. A ticket type with a price above 0 can only be ordered
-- once its event has a paid_sales_activations row with activated_at set. The checklist
-- that leads there is spread over three places, on purpose:
--   * identity and the payout account belong to the organizer: organizer_profiles
--   * the activation fee is a payment: payments
--   * accepting the terms and activating are per event: paid_sales_activations
--
-- Everything that looks like money here is demonstration data. No money ever moves in
-- the academic MVP, and the payments table refuses to say otherwise.

-- ---------------------------------------------------------------------------
-- organizer_profiles: simulated identity check
-- ---------------------------------------------------------------------------
-- NULL until POST /api/me/organizer-profile/verify-identity. The check is simulated:
-- nothing about the person's documents is stored, only that the step was done.
ALTER TABLE organizer_profiles ADD COLUMN identity_verified_at TIMESTAMPTZ;

COMMENT ON COLUMN organizer_profiles.identity_verified_at IS
  'Simulated identity check for the academic MVP. No documents are checked or stored.';

-- ---------------------------------------------------------------------------
-- payments
-- ---------------------------------------------------------------------------
-- One row per successful payment: either for an order or for an event's activation
-- fee. Free orders have no payment row.
CREATE TABLE payments (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose          TEXT NOT NULL CHECK (purpose IN ('order', 'activation_fee')),
  -- RESTRICT on all three: a payment is a financial record, even a simulated one.
  order_id         UUID REFERENCES orders (id) ON DELETE RESTRICT,
  event_id         UUID REFERENCES events (id) ON DELETE RESTRICT,
  paid_by          UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  amount           INTEGER NOT NULL CHECK (amount > 0),  -- tiyn
  currency         TEXT NOT NULL DEFAULT 'KZT',
  -- A real provider would add a value here and set is_demonstration to false.
  method           TEXT NOT NULL CHECK (method IN ('simulated')),
  is_demonstration BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- An order payment points at an order and nothing else, a fee at an event.
  CONSTRAINT payments_target CHECK (
    (purpose = 'order' AND order_id IS NOT NULL AND event_id IS NULL)
    OR (purpose = 'activation_fee' AND event_id IS NOT NULL AND order_id IS NULL)
  ),
  -- SRS 4.6: demonstration payments are never presented as real. A simulated payment
  -- that claims to be real is refused by the database, not just by the API.
  CONSTRAINT payments_simulated_is_demonstration CHECK (method <> 'simulated' OR is_demonstration)
);

-- At most one payment per order and one activation fee per event. Paying twice is
-- refused here even if two requests race past the API's own check.
CREATE UNIQUE INDEX payments_order_id_idx ON payments (order_id);
CREATE UNIQUE INDEX payments_activation_fee_event_id_idx ON payments (event_id)
  WHERE purpose = 'activation_fee';
CREATE INDEX payments_paid_by_idx ON payments (paid_by);

CREATE TRIGGER payments_set_updated_at BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- paid_sales_activations
-- ---------------------------------------------------------------------------
-- One row per event, created by the first per-event step (terms or activation). No row
-- means nothing has been done yet.
CREATE TABLE paid_sales_activations (
  -- The event is the key: activation applies only to the selected event (SRS 4.5).
  -- RESTRICT, like orders: this is the record that paid sales were allowed.
  event_id          UUID PRIMARY KEY REFERENCES events (id) ON DELETE RESTRICT,
  terms_accepted_at TIMESTAMPTZ,
  terms_accepted_by UUID REFERENCES users (id) ON DELETE SET NULL,
  -- Set once every checklist item was true. Paid ticket types are buyable from then on.
  activated_at      TIMESTAMPTZ,
  activated_by      UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Activating needs the terms, so an activated row without them is always a bug.
  CONSTRAINT paid_sales_activations_terms_before_activation
    CHECK (activated_at IS NULL OR terms_accepted_at IS NOT NULL)
);

CREATE INDEX paid_sales_activations_terms_accepted_by_idx
  ON paid_sales_activations (terms_accepted_by);
CREATE INDEX paid_sales_activations_activated_by_idx ON paid_sales_activations (activated_by);

CREATE TRIGGER paid_sales_activations_set_updated_at BEFORE UPDATE ON paid_sales_activations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
