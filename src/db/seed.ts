/**
 * Demo data so a fresh database has something to show: events to browse, a person on
 * the door, and two paid tickets to scan.
 *
 * Run it with `npm run seed`. Safe to run twice: every row has a hard-coded id and is
 * inserted with ON CONFLICT (id) DO UPDATE, so a second run refreshes the rows instead
 * of creating duplicates.
 *
 * This is fake data for development. Do not run it against anything real.
 */
import bcrypt from 'bcryptjs';
import { pool } from './pool';
import { signTicketPayload } from '../lib/qr';

// Hard-coded UUIDs are what makes the script idempotent, and they are handy in
// Postman: you can paste them into a URL and know the row exists.
// Real ids come from gen_random_uuid(), which produces version 4 UUIDs, so these
// hand-written ones are shaped like version 4 too. Otherwise the Zod uuid() check in
// the routes rejects them and the demo data looks broken.
const ORGANIZER_ID = '11111111-1111-4111-8111-111111111111';
const ATTENDEE_ID = '22222222-2222-4222-8222-222222222222';
const EVENT_TECH_ID = '33333333-3333-4333-8333-333333333333';
const EVENT_JAZZ_ID = '44444444-4444-4444-8444-444444444444';
const TT_TECH_EARLY_ID = '55555555-5555-4555-8555-555555555555';
const TT_TECH_REGULAR_ID = '66666666-6666-4666-8666-666666666666';
const TT_JAZZ_STANDARD_ID = '77777777-7777-4777-8777-777777777777';
const DOOR_ID = '88888888-8888-4888-8888-888888888888';
const ORDER_ID = '99999999-9999-4999-8999-999999999999';
const ORDER_ITEM_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TICKET_1_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TICKET_2_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const FEE_PAYMENT_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ORDER_PAYMENT_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

// Every seeded user logs in with this password. It is printed at the end of the run,
// which is fine for dev data and would be a disaster anywhere else.
const DEV_PASSWORD = 'biletflow-dev';

async function seed(): Promise<void> {
  // Same rounds as routes/auth.ts, so login treats these like any other account. The
  // password is reset on every run, in case somebody changed it while testing.
  const passwordHash = await bcrypt.hash(DEV_PASSWORD, 10);

  // The door user is a plain attendee on purpose: being on an event's staff is what
  // lets somebody scan (docs/decisions.md), not their role.
  await pool.query(
    `INSERT INTO users (id, email, password_hash, name, role, email_verified_at)
     VALUES ($1, $2, $4, $3, 'organizer', now()), ($5, $6, $4, $7, 'attendee', now()), ($8, $9, $4, $10, 'attendee', now())
     ON CONFLICT (id) DO UPDATE
       SET email = EXCLUDED.email,
           password_hash = EXCLUDED.password_hash,
           name = EXCLUDED.name,
           role = EXCLUDED.role,
           email_verified_at = now()`,
    [
      ORGANIZER_ID,
      'organizer@biletflow.kz',
      'Aigerim S.',
      passwordHash,
      ATTENDEE_ID,
      'attendee@biletflow.kz',
      'Aidos K.',
      DOOR_ID,
      'door@biletflow.kz',
      'Dana T.',
    ],
  );

  // An organizer is a user with an organizer profile (migration 003). The payout
  // account is demonstration data, like every payout in the MVP, and the identity check
  // is the simulated one from migration 004.
  await pool.query(
    `INSERT INTO organizer_profiles (user_id, display_name, contact_email, contact_phone,
                                     payout_bank_name, payout_iban, payout_account_holder,
                                     identity_verified_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (user_id) DO UPDATE
       SET display_name = EXCLUDED.display_name,
           contact_email = EXCLUDED.contact_email,
           contact_phone = EXCLUDED.contact_phone,
           payout_bank_name = EXCLUDED.payout_bank_name,
           payout_iban = EXCLUDED.payout_iban,
           payout_account_holder = EXCLUDED.payout_account_holder,
           identity_verified_at = COALESCE(organizer_profiles.identity_verified_at, now())`,
    [
      ORGANIZER_ID,
      'Astana Tech Community',
      'organizer@biletflow.kz',
      '+77011234567',
      'Demo Bank',
      'KZ000000000000000000',
      'Aigerim S.',
    ],
  );

  // starts_at is relative to now() so the demo events are always upcoming, however
  // long after today somebody clones this repo.
  await pool.query(
    `INSERT INTO events (id, organizer_id, title, description, venue_name, venue_address,
                         starts_at, ends_at, status, cover_image_url)
     VALUES
       ($1, $2, $3, $4, $5, $6, now() + interval '30 days', now() + interval '30 days 3 hours', 'published', $7),
       ($8, $2, $9, $10, $11, $12, now() + interval '45 days', now() + interval '45 days 4 hours', 'published', $13)
     ON CONFLICT (id) DO UPDATE
       SET title = EXCLUDED.title,
           description = EXCLUDED.description,
           venue_name = EXCLUDED.venue_name,
           venue_address = EXCLUDED.venue_address,
           starts_at = EXCLUDED.starts_at,
           ends_at = EXCLUDED.ends_at,
           status = EXCLUDED.status`,
    [
      EVENT_TECH_ID,
      ORGANIZER_ID,
      'Astana Tech Meetup',
      'Monthly meetup for developers in Astana. Three talks, then pizza and questions.',
      'Nazarbayev University',
      'Kabanbay Batyr 53, Astana',
      'https://picsum.photos/seed/biletflow-tech/800/450',
      EVENT_JAZZ_ID,
      'Almaty Jazz Night',
      'Local quartet playing standards and a few originals. Doors open an hour early.',
      'Almaty Philharmonic',
      'Kaldayakov 35, Almaty',
      'https://picsum.photos/seed/biletflow-jazz/800/450',
    ],
  );

  // Prices are tiyn: 500000 tiyn = 5000 KZT. The free tier is price 0, which is a
  // normal order in the flow described in docs/api.md, not a special case.
  await pool.query(
    `INSERT INTO ticket_types (id, event_id, name, price, quantity_total, is_hidden)
     VALUES ($1, $2, $3, $4, $5, false),
            ($6, $2, $7, $8, $9, false),
            ($10, $11, $12, $13, $14, false)
     ON CONFLICT (id) DO UPDATE
       SET name = EXCLUDED.name,
           price = EXCLUDED.price,
           quantity_total = EXCLUDED.quantity_total`,
    [
      TT_TECH_EARLY_ID,
      EVENT_TECH_ID,
      'Early Bird',
      500000,
      100,
      TT_TECH_REGULAR_ID,
      'Student',
      0,
      50,
      TT_JAZZ_STANDARD_ID,
      EVENT_JAZZ_ID,
      'Standard',
      1200000,
      200,
    ],
  );

  // Paid sales are active on the tech meetup: fee paid (simulated), terms accepted,
  // activated. The jazz night is left inactive on purpose, so the demo can show a paid
  // ticket being refused and the organizer working through the checklist.
  await pool.query(
    `INSERT INTO payments (id, purpose, event_id, paid_by, amount, method)
     VALUES ($1, 'activation_fee', $2, $3, 500000, 'simulated')
     ON CONFLICT (id) DO NOTHING`,
    [FEE_PAYMENT_ID, EVENT_TECH_ID, ORGANIZER_ID],
  );
  await pool.query(
    `INSERT INTO paid_sales_activations
            (event_id, terms_accepted_at, terms_accepted_by, activated_at, activated_by)
     VALUES ($1, now(), $2, now(), $2)
     ON CONFLICT (event_id) DO NOTHING`,
    [EVENT_TECH_ID, ORGANIZER_ID],
  );

  // The organizer puts Dana on the door of the tech meetup. No fixed id: the pair
  // (event_id, user_id) is what makes an assignment unique, and it may already exist
  // from somebody testing POST /api/events/:id/staff.
  await pool.query(
    `INSERT INTO event_staff (event_id, user_id, assigned_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (event_id, user_id) DO NOTHING`,
    [EVENT_TECH_ID, DOOR_ID, ORGANIZER_ID],
  );

  // Aidos bought two Early Bird tickets, already paid, so there is something to scan
  // before orders and payment exist. A paid order never expires, so expires_at is NULL.
  await pool.query(
    `INSERT INTO orders (id, user_id, event_id, status, subtotal, discount, total, expires_at)
     VALUES ($1, $2, $3, 'paid', 1000000, 0, 1000000, NULL)
     ON CONFLICT (id) DO UPDATE
       SET status = EXCLUDED.status,
           subtotal = EXCLUDED.subtotal,
           discount = EXCLUDED.discount,
           total = EXCLUDED.total,
           expires_at = EXCLUDED.expires_at`,
    [ORDER_ID, ATTENDEE_ID, EVENT_TECH_ID],
  );

  // Paid orders above 0 KZT have a demonstration payment, like any paid through /pay.
  await pool.query(
    `INSERT INTO payments (id, purpose, order_id, paid_by, amount, method)
     VALUES ($1, 'order', $2, $3, 1000000, 'simulated')
     ON CONFLICT (id) DO NOTHING`,
    [ORDER_PAYMENT_ID, ORDER_ID, ATTENDEE_ID],
  );

  await pool.query(
    `INSERT INTO order_items (id, order_id, ticket_type_id, name, quantity, unit_price)
     VALUES ($1, $2, $3, 'Early Bird', 2, 500000)
     ON CONFLICT (id) DO UPDATE
       SET name = EXCLUDED.name, quantity = EXCLUDED.quantity, unit_price = EXCLUDED.unit_price`,
    [ORDER_ITEM_ID, ORDER_ID, TT_TECH_EARLY_ID],
  );

  // Re-running the seed puts both tickets back to valid, so the door can be tested
  // again from scratch after a round of check-ins.
  await pool.query(
    `INSERT INTO tickets (id, order_item_id, event_id, ticket_type_id, code, status, attendee_name)
     VALUES ($1, $3, $4, $5, 'BF-7K2M-9XQP', 'valid', 'Aidos K.'),
            ($2, $3, $4, $5, 'BF-4HTR-2WNA', 'valid', 'Aidos K.')
     ON CONFLICT (id) DO UPDATE
       SET code = EXCLUDED.code,
           status = 'valid',
           attendee_name = EXCLUDED.attendee_name,
           checked_in_at = NULL,
           checked_in_by = NULL`,
    [TICKET_1_ID, TICKET_2_ID, ORDER_ITEM_ID, EVENT_TECH_ID, TT_TECH_EARLY_ID],
  );

  console.log(
    'Seeded 3 users, 1 organizer profile, 2 published events, 3 ticket types,',
    '1 staff assignment, 1 paid order with 2 tickets,',
    'paid sales active on the tech meetup and not on the jazz night.',
  );
  console.log(`Log in as organizer@, attendee@ or door@biletflow.kz with "${DEV_PASSWORD}".`);
  console.log(`Try: GET /api/events/${EVENT_TECH_ID}`);
  // Signed with JWT_SECRET from .env, so they scan only against a server using the same
  // secret. Paste one into a QR generator to get a code the phone can read.
  console.log('QR payloads for the two tickets:');
  console.log(`  ${signTicketPayload(TICKET_1_ID)}`);
  console.log(`  ${signTicketPayload(TICKET_2_ID)}`);
}

seed()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error(err);
    await pool.end();
    process.exit(1);
  });
