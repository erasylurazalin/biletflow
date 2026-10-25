-- 009_promo_codes.sql
-- Promotional campaigns: promo codes and campaign QR codes (SRS 4.14, UC10).
--
-- A campaign belongs to one event and carries a discount (percent or a fixed KZT
-- amount), an optional validity window, an optional redemption limit and an optional
-- list of the ticket types it covers. Each campaign has two secrets:
--
-- - a `code` the buyer types at checkout, stored upper-case and unique across the
--   platform, matched case-insensitively;
-- - an opaque `token` that goes into the campaign link
--   (${webUrl()}/events/<event id>?promo=<token>). The link never contains the code's
--   discount or any price, and the campaign QR code is a picture of exactly that link,
--   so a scan at the door stays `invalid` (src/lib/qr.ts refuses anything without the
--   BF1: prefix).
--
-- A redemption is one row per order in promo_redemptions. Like inventory
-- (001_init.sql, HELD_SQL in routes/ticket-types.ts) it is never a stored counter: a
-- redemption counts while its order is paid or pending and not expired, so an
-- abandoned checkout frees the code by itself and nothing sweeps expired rows. The
-- limit is enforced under a lock on the campaign row inside the order transaction
-- (routes/orders.ts), so it holds when many people check out at once.
--
-- Everything that looks like money here is demonstration data, like payments (004)
-- and refunds (008): discount amounts are tiyn, never real.

CREATE TABLE promo_campaigns (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        UUID NOT NULL REFERENCES events (id) ON DELETE RESTRICT,
  name            TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  -- Upper-case only. The API refuses anything else; this holds even for hand-written
  -- SQL. Uniqueness is case-insensitive through the index below.
  code            TEXT NOT NULL CHECK (code ~ '^[A-Z0-9]{6,20}$'),
  -- 24 random bytes, base64url (always 32 characters): the secret in the campaign link.
  token           TEXT NOT NULL,
  discount_type   TEXT NOT NULL CHECK (discount_type IN ('percent', 'fixed')),
  -- percent: 1 to 100. fixed: an amount in tiyn above 0.
  discount_value  INTEGER NOT NULL CHECK (
    (discount_type = 'percent' AND discount_value BETWEEN 1 AND 100)
    OR (discount_type = 'fixed' AND discount_value > 0)
  ),
  starts_at       TIMESTAMPTZ,
  ends_at         TIMESTAMPTZ,
  -- NULL means unlimited.
  max_redemptions INTEGER CHECK (max_redemptions IS NULL OR max_redemptions > 0),
  -- NULL means every ticket type of the event. The API checks that each listed id
  -- belongs to the event; the database cannot without a join, so it does not.
  ticket_type_ids UUID[],
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_by      UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The validity window, when both ends are set, must not end before it starts.
  CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at)
);

CREATE INDEX promo_campaigns_event_id_idx ON promo_campaigns (event_id);
-- Unique across the platform, case-insensitively: upper(code) of stored upper-case
-- codes is the code itself, so this is one index for both.
CREATE UNIQUE INDEX promo_campaigns_code_key ON promo_campaigns (upper(code));
CREATE UNIQUE INDEX promo_campaigns_token_key ON promo_campaigns (token);

-- One redemption per order: an order uses a code once or not at all. RESTRICT like
-- payments and refunds: a redemption is a money record, even a simulated one. Rows of
-- refunded or expired orders stay where they are; they just stop counting.
CREATE TABLE promo_redemptions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id     UUID NOT NULL REFERENCES promo_campaigns (id) ON DELETE RESTRICT,
  order_id        UUID NOT NULL UNIQUE REFERENCES orders (id) ON DELETE RESTRICT,
  discount_amount INTEGER NOT NULL CHECK (discount_amount >= 0),  -- tiyn
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX promo_redemptions_campaign_id_idx ON promo_redemptions (campaign_id);

-- Which campaign an order redeemed, if any. RESTRICT like every other money column.
ALTER TABLE orders ADD COLUMN promo_campaign_id UUID REFERENCES promo_campaigns (id) ON DELETE RESTRICT;
