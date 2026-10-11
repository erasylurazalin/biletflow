-- 003_organizer_profiles.sql
-- What makes somebody an organizer.
--
-- Everyone registers as a regular user. Creating an organizer profile (POST
-- /api/me/organizer-profile) is self-service, needs no approval, and switches the
-- user's role to 'organizer'. Verification is a separate, later step that only gates
-- paid ticket sales, never creating events, so nothing here blocks an organizer.

-- ---------------------------------------------------------------------------
-- organizer_profiles
-- ---------------------------------------------------------------------------
CREATE TABLE organizer_profiles (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- UNIQUE: one profile per user. A second POST hits this constraint and becomes 409.
  -- CASCADE: the profile means nothing without its user. Deleting an organizer who
  -- has events is already blocked by events.organizer_id (RESTRICT).
  user_id               UUID NOT NULL UNIQUE REFERENCES users (id) ON DELETE CASCADE,
  -- The name attendees see as the organizer, for example "Astana Tech Community".
  display_name          TEXT NOT NULL,
  -- How attendees and the platform reach the organizer. Either one is enough.
  contact_email         TEXT,
  contact_phone         TEXT,
  -- Payouts are simulated in the academic MVP: nothing reads these to move money.
  -- Doc is silent on more than one payout account, so it is one, on the profile.
  payout_bank_name      TEXT,
  payout_iban           TEXT,
  payout_account_holder TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT organizer_profiles_contact_present
    CHECK (contact_email IS NOT NULL OR contact_phone IS NOT NULL),
  -- The payout account is all three fields or none, never half an account.
  CONSTRAINT organizer_profiles_payout_complete
    CHECK ((payout_bank_name IS NULL) = (payout_iban IS NULL)
       AND (payout_iban IS NULL) = (payout_account_holder IS NULL))
);

COMMENT ON COLUMN organizer_profiles.payout_bank_name IS
  'Demonstration data: payouts are simulated in the academic MVP.';
COMMENT ON COLUMN organizer_profiles.payout_iban IS
  'Demonstration data: payouts are simulated in the academic MVP.';
COMMENT ON COLUMN organizer_profiles.payout_account_holder IS
  'Demonstration data: payouts are simulated in the academic MVP.';

CREATE TRIGGER organizer_profiles_set_updated_at BEFORE UPDATE ON organizer_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
