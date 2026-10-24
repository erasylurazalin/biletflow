-- 007_checkout_details.sql
-- Per-ticket attendee names and the attendee processing charge (SRS 4.6).
--
-- Attendee names belong to order items so they remain attached to the purchased seats.
-- The processing charge is stored separately from the ticket subtotal and discount.

ALTER TABLE orders ADD COLUMN processing_fee INTEGER NOT NULL DEFAULT 0 CHECK (processing_fee >= 0);
ALTER TABLE order_items ADD COLUMN attendee_names TEXT[];
ALTER TABLE order_items ADD CONSTRAINT order_items_attendee_names_match_quantity
  CHECK (attendee_names IS NULL OR cardinality(attendee_names) = quantity);
