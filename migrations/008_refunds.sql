-- 008_refunds.sql
-- Cancellations and refunds (SRS 4.9, UC5).
--
-- The organizer can fully refund a paid order (simulated) or cancel a free
-- registration. No partial refunds, no attendee-initiated refunds. An order that is
-- refunded or cancelled releases its seats automatically: inventory is computed from
-- the orders table (001_init.sql, HELD_SQL in routes/ticket-types.ts), so only the
-- order status changes.
--
-- Like payments (004_paid_sales.sql), everything that looks like money here is
-- demonstration data, and the table refuses to say otherwise.

-- Optional free text shown to attendees on the event page (docs/api.md "Events").
-- Information only: nothing in the code enforces it.
ALTER TABLE events ADD COLUMN refund_policy TEXT;

-- One row per refunded order, written by POST /api/events/:id/orders/:orderId/refund.
-- RESTRICT like payments: a refund is a financial record, even a simulated one.
CREATE TABLE refunds (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- UNIQUE: exactly one refund per order. The API checks too, but this holds even if
  -- two requests race past it.
  order_id         UUID NOT NULL UNIQUE REFERENCES orders (id) ON DELETE RESTRICT,
  amount           INTEGER NOT NULL CHECK (amount > 0),  -- tiyn; a free order is cancelled, not refunded
  currency         TEXT NOT NULL DEFAULT 'KZT',
  refunded_by      UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  -- A real provider would add a value here and set is_demonstration to false.
  method           TEXT NOT NULL CHECK (method IN ('simulated')),
  is_demonstration BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Same rule as payments: SRS 4.6 forbids presenting demonstration money as real.
  CONSTRAINT refunds_simulated_is_demonstration CHECK (method <> 'simulated' OR is_demonstration)
);

CREATE INDEX refunds_refunded_by_idx ON refunds (refunded_by);
