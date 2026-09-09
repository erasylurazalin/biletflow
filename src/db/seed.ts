/**
 * Demo data so `GET /api/events` returns something on a fresh database.
 *
 * Run it with `npm run seed`. Safe to run twice: every row has a hard-coded id and is
 * inserted with ON CONFLICT (id) DO UPDATE, so a second run refreshes the rows instead
 * of creating duplicates.
 *
 * This is fake data for development. Do not run it against anything real.
 */
import { pool } from './pool';

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

// Auth is not built yet, so there is no real hashing function to call here. Login will
// simply not work for these users until that lands, which is fine for GET endpoints.
const PLACEHOLDER_HASH = 'seed-placeholder-not-a-real-hash';

async function seed(): Promise<void> {
  await pool.query(
    `INSERT INTO users (id, email, password_hash, name, role)
     VALUES ($1, $2, $3, $4, $5), ($6, $7, $8, $9, $10)
     ON CONFLICT (id) DO UPDATE
       SET email = EXCLUDED.email, name = EXCLUDED.name, role = EXCLUDED.role`,
    [
      ORGANIZER_ID,
      'organizer@biletflow.kz',
      PLACEHOLDER_HASH,
      'Aigerim S.',
      'organizer',
      ATTENDEE_ID,
      'attendee@biletflow.kz',
      PLACEHOLDER_HASH,
      'Aidos K.',
      'attendee',
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

  console.log('Seeded 2 users, 2 published events, 3 ticket types.');
  console.log(`Try: GET /api/events/${EVENT_TECH_ID}`);
}

seed()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error(err);
    await pool.end();
    process.exit(1);
  });
