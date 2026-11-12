/**
 * Demo data, so a fresh database shows something on every page without clicking through
 * setup first. Run it with `npm run seed`.
 *
 * What it creates (SRS section 11 criteria in brackets):
 *   - Astana Tech Meetup: paid and free orders, a promo campaign with redemptions [7],
 *     and a few tickets already scanned at the door [10]
 *   - a cancelled past event whose orders were all refunded, with its activity timeline
 *     in audit_log [9, 11]
 *   - Almaty Jazz Night: a hidden VIP ticket type that only a promo code unlocks
 *
 * Idempotent: every row has a hard-coded id and is inserted with ON CONFLICT DO NOTHING,
 * and the whole run is one transaction. A second run inserts nothing and changes
 * nothing, not even updated_at. The price of that: dates are relative to the FIRST run
 * (now() at that moment) and then stay put, and editing this file does not change rows
 * that already exist. To start over, recreate the database.
 *
 * The data follows the rules in the migrations and docs/api.md, so it is something the
 * API could have produced: money in tiyn, simulated payments (one per paid order, none
 * for free ones), a 3% processing fee that is part of the total, one refund per refunded
 * order for the full total, paid ticket types only on events with paid sales activated,
 * a hidden ticket type orderable only through a campaign that lists it, and an audit
 * entry for each action, using the action names from the "Audit log" table.
 *
 * This is fake data for development. Do not run it against anything real.
 */
import { pool } from './pool';

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------
// Hard-coded UUIDs are what makes the script idempotent, and they are handy in
// Postman. They must look like real version 4 UUIDs, or the Zod uuid() check in the
// routes rejects them. seedId() builds such ids: `kind` says what the row is, `n` which
// one, so 0xb3 / 1 is "order 1".
const seedId = (kind: number, n: number): string =>
  `${kind.toString(16).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;

// The ids the first version of this seed already used. Do not change them.
const ORGANIZER_ID = '11111111-1111-4111-8111-111111111111';
const ATTENDEE_ID = '22222222-2222-4222-8222-222222222222';
const EVENT_TECH_ID = '33333333-3333-4333-8333-333333333333';
const EVENT_JAZZ_ID = '44444444-4444-4444-8444-444444444444';
const TT_TECH_EARLY_ID = '55555555-5555-4555-8555-555555555555';
const TT_TECH_REGULAR_ID = '66666666-6666-4666-8666-666666666666';
const TT_JAZZ_STANDARD_ID = '77777777-7777-4777-8777-777777777777';

// New in this version.
const EVENT_ADMIN_ID = seedId(0xb0, 1);
const MADINA_ID = seedId(0xb0, 2);
const TIMUR_ID = seedId(0xb0, 3);
const SOFIA_ID = seedId(0xb0, 4);
const YERLAN_ID = seedId(0xb0, 5);
const EVENT_CANCELLED_ID = seedId(0xb1, 1);
const TT_JAZZ_VIP_ID = seedId(0xb2, 1);
const TT_CANCELLED_GENERAL_ID = seedId(0xb2, 2);
const PROFILE_ID = seedId(0xba, 1);
const CAMPAIGN_COMMUNITY_ID = seedId(0xb8, 1);
const CAMPAIGN_JAZZ_VIP_ID = seedId(0xb8, 2);

// Prices are tiyn: 500000 tiyn = 5000 KZT. A free ticket is price 0, a normal order in
// the flow described in docs/api.md, not a special case.
const PRICE_EARLY_BIRD = 500000;
const PRICE_STUDENT = 0;
const PRICE_JAZZ_STANDARD = 1200000;
const PRICE_JAZZ_VIP = 2500000;
const PRICE_CANCELLED_GENERAL = 800000;

// docs/api.md, "Paid sales activation": the fee is 5,000 KZT.
const ACTIVATION_FEE_TIYN = 500000;
// docs/api.md, "Creating an order": processing_fee is 3% of subtotal - discount.
const PROCESSING_FEE_PERCENT = 3;
// The organizer called the cancelled event off this many days ago and refunded right after.
const EVENT_CANCELLED_DAYS_AGO = 22;

// Auth exists now, but this seed does not hash a password: these users cannot log in.
// TODO: replace with a real hash (same function the register endpoint uses) so the demo
// organizer can open the analytics and promo pages in the browser.
const PLACEHOLDER_HASH = 'seed-placeholder-not-a-real-hash';

// base64url-looking, 32 characters like the real tokens (24 random bytes). Known to
// everybody who reads this file, which is fine for dev data and handy for a demo link.
const demoToken = (label: string): string => `seed-${label}`.padEnd(32, '0').slice(0, 32);

// For audit descriptions, like "Price changed from 5000 to 6000 KZT" in docs/api.md.
const kzt = (tiyn: number): string => `${Number((tiyn / 100).toFixed(2))} KZT`;

// ---------------------------------------------------------------------------
// The data
// ---------------------------------------------------------------------------
const USERS = [
  { id: ORGANIZER_ID, email: 'organizer@biletflow.kz', name: 'Aigerim S.', role: 'organizer' },
  { id: ATTENDEE_ID, email: 'attendee@biletflow.kz', name: 'Aidos K.', role: 'attendee' },
  { id: EVENT_ADMIN_ID, email: 'door@biletflow.kz', name: 'Dana T.', role: 'event_admin' },
  { id: MADINA_ID, email: 'madina@biletflow.kz', name: 'Madina B.', role: 'attendee' },
  { id: TIMUR_ID, email: 'timur@biletflow.kz', name: 'Timur N.', role: 'attendee' },
  { id: SOFIA_ID, email: 'sofia@biletflow.kz', name: 'Sofia L.', role: 'attendee' },
  { id: YERLAN_ID, email: 'yerlan@biletflow.kz', name: 'Yerlan A.', role: 'attendee' },
];

// startsInDays is relative to the first run; negative means in the past. An event is
// published after its ticket type exists and while its start is still in the future
// (docs/api.md, "Events").
const EVENTS = [
  {
    id: EVENT_TECH_ID,
    title: 'Astana Tech Meetup',
    description: 'Monthly meetup for developers in Astana. Three talks, then pizza and questions.',
    venueName: 'Nazarbayev University',
    venueAddress: 'Kabanbay Batyr 53, Astana',
    startsInDays: 30,
    durationHours: 3,
    status: 'published',
    cover: 'https://picsum.photos/seed/biletflow-tech/800/450',
    refundPolicy: null,
    createdDaysAgo: 40,
    publishedDaysAgo: 39,
  },
  {
    id: EVENT_JAZZ_ID,
    title: 'Almaty Jazz Night',
    description: 'Local quartet playing standards and a few originals. Doors open an hour early.',
    venueName: 'Almaty Philharmonic',
    venueAddress: 'Kaldayakov 35, Almaty',
    startsInDays: 45,
    durationHours: 4,
    status: 'published',
    cover: 'https://picsum.photos/seed/biletflow-jazz/800/450',
    refundPolicy: null,
    createdDaysAgo: 40,
    publishedDaysAgo: 39,
  },
  {
    id: EVENT_CANCELLED_ID,
    title: 'Almaty Startup Pitch Night',
    description:
      'Evening of five-minute startup pitches. Cancelled when the venue closed; every order was refunded.',
    venueName: 'Almaty Startup Hub',
    venueAddress: 'Dostyk 85, Almaty',
    startsInDays: -21,
    durationHours: 3,
    status: 'cancelled',
    cover: 'https://picsum.photos/seed/biletflow-pitch/800/450',
    refundPolicy: 'If the organizer cancels the event, every ticket is refunded in full.',
    createdDaysAgo: 60,
    publishedDaysAgo: 58,
  },
];

const TICKET_TYPES = [
  {
    id: TT_TECH_EARLY_ID,
    eventId: EVENT_TECH_ID,
    name: 'Early Bird',
    price: PRICE_EARLY_BIRD,
    total: 100,
    hidden: false,
    createdDaysAgo: 40,
  },
  {
    id: TT_TECH_REGULAR_ID,
    eventId: EVENT_TECH_ID,
    name: 'Student',
    price: PRICE_STUDENT,
    total: 50,
    hidden: false,
    createdDaysAgo: 40,
  },
  {
    id: TT_JAZZ_STANDARD_ID,
    eventId: EVENT_JAZZ_ID,
    name: 'Standard',
    price: PRICE_JAZZ_STANDARD,
    total: 200,
    hidden: false,
    createdDaysAgo: 40,
  },
  // Hidden: not in the public ticket list. Campaign B below lists it in ticket_type_ids,
  // and that is the only way to order it (docs/api.md, "Creating an order").
  {
    id: TT_JAZZ_VIP_ID,
    eventId: EVENT_JAZZ_ID,
    name: 'VIP Table',
    price: PRICE_JAZZ_VIP,
    total: 20,
    hidden: true,
    createdDaysAgo: 12,
  },
  {
    id: TT_CANCELLED_GENERAL_ID,
    eventId: EVENT_CANCELLED_ID,
    name: 'General',
    price: PRICE_CANCELLED_GENERAL,
    total: 80,
    hidden: false,
    createdDaysAgo: 59,
  },
];

// Every event that sells a paid ticket type must have paid sales activated (004).
const ACTIVATIONS = [
  { eventId: EVENT_TECH_ID, daysAgo: 14 },
  { eventId: EVENT_JAZZ_ID, daysAgo: 10 },
  { eventId: EVENT_CANCELLED_ID, daysAgo: 35 },
];

const CAMPAIGNS = [
  {
    id: CAMPAIGN_COMMUNITY_ID,
    eventId: EVENT_TECH_ID,
    name: 'Community discount',
    code: 'COMMUNITY20',
    token: demoToken('community20'),
    percent: 20,
    startedDaysAgo: 10,
    endsInDays: 25,
    maxRedemptions: 50,
    ticketTypeIds: [TT_TECH_EARLY_ID],
    createdDaysAgo: 11,
  },
  {
    id: CAMPAIGN_JAZZ_VIP_ID,
    eventId: EVENT_JAZZ_ID,
    name: 'VIP table invitation',
    code: 'JAZZVIP15',
    token: demoToken('jazzvip15'),
    percent: 15,
    startedDaysAgo: 5,
    endsInDays: 40,
    maxRedemptions: 10,
    ticketTypeIds: [TT_JAZZ_VIP_ID],
    createdDaysAgo: 5,
  },
];

interface OrderSeed {
  n: number; // stable number: order, item, payment and ticket ids are built from it
  userId: string;
  eventId: string;
  ticketTypeId: string;
  ticketName: string;
  unitPrice: number; // tiyn
  attendeeNames: string[]; // one per ticket, so quantity = attendeeNames.length
  daysAgo: number;
  campaign?: { id: string; percent: number };
  refundedDaysAgo?: number; // set: the order was fully refunded that many days ago
  checkedIn?: number; // how many of its tickets were scanned at the door
}

const ORDERS: OrderSeed[] = [
  // Astana Tech Meetup: 8 tickets sold, 4 of them already scanned.
  {
    n: 1,
    userId: ATTENDEE_ID,
    eventId: EVENT_TECH_ID,
    ticketTypeId: TT_TECH_EARLY_ID,
    ticketName: 'Early Bird',
    unitPrice: PRICE_EARLY_BIRD,
    attendeeNames: ['Aidos K.', 'Aruzhan M.'],
    daysAgo: 8,
    checkedIn: 2,
  },
  {
    n: 2,
    userId: MADINA_ID,
    eventId: EVENT_TECH_ID,
    ticketTypeId: TT_TECH_EARLY_ID,
    ticketName: 'Early Bird',
    unitPrice: PRICE_EARLY_BIRD,
    attendeeNames: ['Madina B.'],
    daysAgo: 6,
    campaign: { id: CAMPAIGN_COMMUNITY_ID, percent: 20 },
    checkedIn: 1,
  },
  {
    n: 3,
    userId: TIMUR_ID,
    eventId: EVENT_TECH_ID,
    ticketTypeId: TT_TECH_EARLY_ID,
    ticketName: 'Early Bird',
    unitPrice: PRICE_EARLY_BIRD,
    attendeeNames: ['Timur N.', 'Alikhan N.'],
    daysAgo: 4,
    campaign: { id: CAMPAIGN_COMMUNITY_ID, percent: 20 },
  },
  {
    n: 4,
    userId: SOFIA_ID,
    eventId: EVENT_TECH_ID,
    ticketTypeId: TT_TECH_EARLY_ID,
    ticketName: 'Early Bird',
    unitPrice: PRICE_EARLY_BIRD,
    attendeeNames: ['Sofia L.'],
    daysAgo: 2,
    campaign: { id: CAMPAIGN_COMMUNITY_ID, percent: 20 },
  },
  {
    n: 5,
    userId: YERLAN_ID,
    eventId: EVENT_TECH_ID,
    ticketTypeId: TT_TECH_REGULAR_ID,
    ticketName: 'Student',
    unitPrice: PRICE_STUDENT,
    attendeeNames: ['Yerlan A.', 'Dias A.'],
    daysAgo: 5,
    checkedIn: 1,
  },
  // Cancelled event: both paid orders refunded after the cancellation.
  {
    n: 6,
    userId: MADINA_ID,
    eventId: EVENT_CANCELLED_ID,
    ticketTypeId: TT_CANCELLED_GENERAL_ID,
    ticketName: 'General',
    unitPrice: PRICE_CANCELLED_GENERAL,
    attendeeNames: ['Madina B.', 'Zarina B.'],
    daysAgo: 30,
    refundedDaysAgo: EVENT_CANCELLED_DAYS_AGO,
  },
  {
    n: 7,
    userId: TIMUR_ID,
    eventId: EVENT_CANCELLED_ID,
    ticketTypeId: TT_CANCELLED_GENERAL_ID,
    ticketName: 'General',
    unitPrice: PRICE_CANCELLED_GENERAL,
    attendeeNames: ['Timur N.'],
    daysAgo: 29,
    refundedDaysAgo: EVENT_CANCELLED_DAYS_AGO,
  },
  // Jazz Night: one VIP table bought with the code that unlocks it.
  {
    n: 8,
    userId: SOFIA_ID,
    eventId: EVENT_JAZZ_ID,
    ticketTypeId: TT_JAZZ_VIP_ID,
    ticketName: 'VIP Table',
    unitPrice: PRICE_JAZZ_VIP,
    attendeeNames: ['Sofia L.'],
    daysAgo: 3,
    campaign: { id: CAMPAIGN_JAZZ_VIP_ID, percent: 15 },
  },
];

// ---------------------------------------------------------------------------
// The script
// ---------------------------------------------------------------------------
async function seed(): Promise<number> {
  const client = await pool.connect();
  let inserted = 0;

  // Counts only rows that were really added: ON CONFLICT DO NOTHING reports 0.
  const insert = async (sql: string, params: unknown[]): Promise<void> => {
    const result = await client.query(sql, params);
    inserted += result.rowCount ?? 0;
  };

  // One audit entry. `n` makes its id stable (audit_log cannot be updated, so a changing
  // id would mean duplicate entries), `minutesAgo` is relative to the first run. The
  // action names are the ones in docs/api.md, "Audit log".
  const audit = (
    n: number,
    minutesAgo: number,
    actorId: string | null,
    action: string,
    entityType: string,
    entityId: string,
    eventId: string | null,
    description: string,
  ): Promise<void> =>
    insert(
      `INSERT INTO audit_log (id, created_at, actor_id, action, entity_type, entity_id,
                              event_id, description)
       VALUES ($1, now() - ($2::int * interval '1 minute'), $3, $4, $5, $6, $7, $8)
       ON CONFLICT DO NOTHING`,
      [seedId(0xbd, n), minutesAgo, actorId, action, entityType, entityId, eventId, description],
    );
  const DAY = 1440; // minutes

  try {
    await client.query('BEGIN');

    for (const u of USERS) {
      await insert(
        `INSERT INTO users (id, email, password_hash, name, role, email_verified_at, created_at)
         VALUES ($1, $2, $3, $4, $5, now() - interval '90 days', now() - interval '90 days')
         ON CONFLICT DO NOTHING`,
        [u.id, u.email, PLACEHOLDER_HASH, u.name, u.role],
      );
    }
    // Users from the first version of this seed were created before email verification
    // existed, so they have no verified email. Fix those. On a second run no row matches,
    // so nothing is touched.
    await client.query(
      `UPDATE users SET email_verified_at = created_at
        WHERE id = ANY($1::uuid[]) AND email_verified_at IS NULL`,
      [USERS.map((u) => u.id)],
    );

    // The organizer profile that makes Aigerim an organizer, with the simulated identity
    // check done and a payout account (all three fields, or none: see 003).
    await insert(
      `INSERT INTO organizer_profiles (id, user_id, display_name, contact_email, payout_bank_name,
                                       payout_iban, payout_account_holder, identity_verified_at, created_at)
       VALUES ($1, $2, 'Astana Tech Community', 'organizer@biletflow.kz', 'Demo Bank',
               'KZ000000000000000000', 'Aigerim S.',
               now() - interval '50 days', now() - interval '60 days')
       ON CONFLICT DO NOTHING`,
      [PROFILE_ID, ORGANIZER_ID],
    );
    await audit(
      300,
      50 * DAY,
      ORGANIZER_ID,
      'organizer_profile.identity_verified',
      'organizer_profile',
      PROFILE_ID,
      null,
      'Identity check completed (simulated)',
    );

    for (const [i, e] of EVENTS.entries()) {
      await insert(
        `INSERT INTO events (id, organizer_id, title, description, venue_name, venue_address,
                             starts_at, ends_at, status, cover_image_url, refund_policy, created_at)
         VALUES ($1, $2, $3, $4, $5, $6,
                 now() + ($7::int * interval '1 day'),
                 now() + ($7::int * interval '1 day') + ($8::int * interval '1 hour'),
                 $9, $10, $11, now() - ($12::int * interval '1 day'))
         ON CONFLICT DO NOTHING`,
        [
          e.id,
          ORGANIZER_ID,
          e.title,
          e.description,
          e.venueName,
          e.venueAddress,
          e.startsInDays,
          e.durationHours,
          e.status,
          e.cover,
          e.refundPolicy,
          e.createdDaysAgo,
        ],
      );
      await audit(
        100 + i,
        e.createdDaysAgo * DAY,
        ORGANIZER_ID,
        'event.created',
        'event',
        e.id,
        e.id,
        `Event "${e.title}" created`,
      );
      await audit(
        330 + i,
        e.publishedDaysAgo * DAY,
        ORGANIZER_ID,
        'event.published',
        'event',
        e.id,
        e.id,
        `Event "${e.title}" published`,
      );
    }
    // The timeline of the cancelled event ends here: cancelled, then every order refunded
    // (see the order loop below).
    await audit(
      360,
      EVENT_CANCELLED_DAYS_AGO * DAY + 30,
      ORGANIZER_ID,
      'event.cancelled',
      'event',
      EVENT_CANCELLED_ID,
      EVENT_CANCELLED_ID,
      'Event cancelled by the organizer',
    );

    for (const [i, t] of TICKET_TYPES.entries()) {
      await insert(
        `INSERT INTO ticket_types (id, event_id, name, price, quantity_total, is_hidden, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, now() - ($7::int * interval '1 day'))
         ON CONFLICT DO NOTHING`,
        [t.id, t.eventId, t.name, t.price, t.total, t.hidden, t.createdDaysAgo],
      );
      const price = t.price === 0 ? 'free' : `at ${kzt(t.price)}`;
      await audit(
        200 + i,
        t.createdDaysAgo * DAY - 5,
        ORGANIZER_ID,
        'ticket_type.created',
        'ticket_type',
        t.id,
        t.eventId,
        `Ticket type "${t.name}" added ${price}${t.hidden ? ', hidden' : ''}`,
      );
    }

    // Paid sales activation, in the order of the SRS 3.2 checklist: the fee is paid,
    // the terms are accepted, then the event is activated. Identity and payout are on
    // the organizer profile above.
    for (const [k, a] of ACTIVATIONS.entries()) {
      const feePaymentId = seedId(0xbc, k + 1);
      await insert(
        `INSERT INTO payments (id, purpose, event_id, paid_by, amount, method, created_at)
         VALUES ($1, 'activation_fee', $2, $3, $4, 'simulated', now() - ($5::int * interval '1 day'))
         ON CONFLICT DO NOTHING`,
        [feePaymentId, a.eventId, ORGANIZER_ID, ACTIVATION_FEE_TIYN, a.daysAgo],
      );
      await insert(
        `INSERT INTO paid_sales_activations (event_id, terms_accepted_at, terms_accepted_by,
                                             activated_at, activated_by, created_at)
         VALUES ($1, now() - ($2::int * interval '1 day'), $3,
                 now() - ($2::int * interval '1 day'), $3, now() - ($2::int * interval '1 day'))
         ON CONFLICT DO NOTHING`,
        [a.eventId, a.daysAgo, ORGANIZER_ID],
      );
      await audit(
        310 + k,
        a.daysAgo * DAY,
        ORGANIZER_ID,
        'paid_sales.fee_paid',
        'payment',
        feePaymentId,
        a.eventId,
        `Paid sales activation fee paid: ${kzt(ACTIVATION_FEE_TIYN)} (simulated)`,
      );
      await audit(
        320 + k,
        a.daysAgo * DAY - 1,
        ORGANIZER_ID,
        'paid_sales.activated',
        'event',
        a.eventId,
        a.eventId,
        'Paid sales activated',
      );
    }

    // Dana works the door at the Tech Meetup, which is why she may have scanned tickets.
    await insert(
      `INSERT INTO event_staff (id, event_id, user_id, assigned_by, created_at)
       VALUES ($1, $2, $3, $4, now() - interval '9 days')
       ON CONFLICT DO NOTHING`,
      [seedId(0xbb, 1), EVENT_TECH_ID, EVENT_ADMIN_ID, ORGANIZER_ID],
    );
    await audit(
      340,
      9 * DAY,
      ORGANIZER_ID,
      'staff.assigned',
      'user',
      EVENT_ADMIN_ID,
      EVENT_TECH_ID,
      'Dana T. assigned to the door',
    );

    for (const [i, c] of CAMPAIGNS.entries()) {
      await insert(
        `INSERT INTO promo_campaigns (id, event_id, name, code, token, discount_type, discount_value,
                                      starts_at, ends_at, max_redemptions, ticket_type_ids,
                                      created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, 'percent', $6,
                 now() - ($7::int * interval '1 day'),
                 now() + ($8::int * interval '1 day'),
                 $9, $10::uuid[], $11, now() - ($12::int * interval '1 day'))
         ON CONFLICT DO NOTHING`,
        [
          c.id,
          c.eventId,
          c.name,
          c.code,
          c.token,
          c.percent,
          c.startedDaysAgo,
          c.endsInDays,
          c.maxRedemptions,
          c.ticketTypeIds,
          ORGANIZER_ID,
          c.createdDaysAgo,
        ],
      );
      await audit(
        350 + i,
        c.createdDaysAgo * DAY,
        ORGANIZER_ID,
        'promo_code.created',
        'promo_code',
        c.id,
        c.eventId,
        `Promo code ${c.code} created: ${c.percent}% off`,
      );
    }

    for (const o of ORDERS) {
      const quantity = o.attendeeNames.length;
      const tickets = `${quantity} ${quantity === 1 ? 'ticket' : 'tickets'}`;
      const subtotal = o.unitPrice * quantity;
      const discount = o.campaign ? Math.round((subtotal * o.campaign.percent) / 100) : 0;
      // The processing fee is never discounted and is part of the total (docs/api.md).
      const processingFee = Math.round(((subtotal - discount) * PROCESSING_FEE_PERCENT) / 100);
      const total = subtotal - discount + processingFee;
      const status = o.refundedDaysAgo === undefined ? 'paid' : 'refunded';
      const orderId = seedId(0xb3, o.n);
      const itemId = seedId(0xb4, o.n);

      // expires_at stays NULL: it is null once an order is paid (docs/api.md).
      await insert(
        `INSERT INTO orders (id, user_id, event_id, status, subtotal, discount, processing_fee,
                             total, promo_campaign_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() - ($10::int * interval '1 day'))
         ON CONFLICT DO NOTHING`,
        [
          orderId,
          o.userId,
          o.eventId,
          status,
          subtotal,
          discount,
          processingFee,
          total,
          o.campaign?.id ?? null,
          o.daysAgo,
        ],
      );

      // name and unit_price are copies of the ticket type at order time, on purpose.
      await insert(
        `INSERT INTO order_items (id, order_id, ticket_type_id, name, quantity, unit_price,
                                  attendee_names, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::text[], now() - ($8::int * interval '1 day'))
         ON CONFLICT DO NOTHING`,
        [
          itemId,
          orderId,
          o.ticketTypeId,
          o.ticketName,
          quantity,
          o.unitPrice,
          o.attendeeNames,
          o.daysAgo,
        ],
      );

      // Free orders have no payment row (004): the amount must be above 0. A payment is
      // for the whole total, fee included.
      if (total > 0) {
        await insert(
          `INSERT INTO payments (id, purpose, order_id, paid_by, amount, method, created_at)
           VALUES ($1, 'order', $2, $3, $4, 'simulated',
                   now() - ($5::int * interval '1 day') + interval '2 minutes')
           ON CONFLICT DO NOTHING`,
          [seedId(0xb6, o.n), orderId, o.userId, total, o.daysAgo],
        );
      }
      await audit(
        400 + o.n,
        o.daysAgo * DAY - 2,
        o.userId,
        'order.paid',
        'order',
        orderId,
        o.eventId,
        total > 0
          ? `Order paid: ${tickets}, ${kzt(total)} (simulated)`
          : `Free registration confirmed: ${tickets}`,
      );

      if (o.campaign) {
        await insert(
          `INSERT INTO promo_redemptions (id, campaign_id, order_id, discount_amount, created_at)
           VALUES ($1, $2, $3, $4, now() - ($5::int * interval '1 day') + interval '1 minute')
           ON CONFLICT DO NOTHING`,
          [seedId(0xb9, o.n), o.campaign.id, orderId, discount, o.daysAgo],
        );
      }

      // A refund is for the whole order total, fee included, recorded as simulated.
      if (o.refundedDaysAgo !== undefined) {
        await insert(
          `INSERT INTO refunds (id, order_id, amount, refunded_by, method, created_at)
           VALUES ($1, $2, $3, $4, 'simulated', now() - ($5::int * interval '1 day'))
           ON CONFLICT DO NOTHING`,
          [seedId(0xb7, o.n), orderId, total, ORGANIZER_ID, o.refundedDaysAgo],
        );
        await audit(
          600 + o.n,
          o.refundedDaysAgo * DAY,
          ORGANIZER_ID,
          'order.refunded',
          'order',
          orderId,
          o.eventId,
          `Order refunded: ${kzt(total)} (simulated)`,
        );
      }

      // One ticket per attendee name. A refunded order's tickets are refunded (invalid).
      for (const [i, name] of o.attendeeNames.entries()) {
        const ticketNo = o.n * 10 + i;
        const ticketId = seedId(0xb5, ticketNo);
        const code = `BF-DEMO-${String(ticketNo).padStart(4, '0')}`;
        const scanned = status === 'paid' && i < (o.checkedIn ?? 0);
        const ticketStatus = status === 'refunded' ? 'refunded' : scanned ? 'checked_in' : 'valid';
        const scannedMinutesAgo = 120 - ticketNo;
        await insert(
          `INSERT INTO tickets (id, order_item_id, event_id, ticket_type_id, code, status,
                                attendee_name, checked_in_at, checked_in_by, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7,
                   CASE WHEN $8::int IS NULL THEN NULL ELSE now() - ($8::int * interval '1 minute') END,
                   $9, now() - ($10::int * interval '1 day') + interval '2 minutes')
           ON CONFLICT DO NOTHING`,
          [
            ticketId,
            itemId,
            o.eventId,
            o.ticketTypeId,
            code,
            ticketStatus,
            name,
            scanned ? scannedMinutesAgo : null,
            scanned ? EVENT_ADMIN_ID : null,
            o.daysAgo,
          ],
        );
        if (scanned) {
          await audit(
            700 + ticketNo,
            scannedMinutesAgo,
            EVENT_ADMIN_ID,
            'ticket.checked_in',
            'ticket',
            ticketId,
            o.eventId,
            `Ticket ${code} checked in`,
          );
        }
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return inserted;
}

async function printSummary(inserted: number): Promise<void> {
  // Read the numbers back from the database, so the summary shows what is really there
  // and a second run prints the same lines.
  const { rows } = await pool.query<{
    tech_tickets: number;
    tech_checked_in: number;
    redemptions: number;
    refunds: number;
    refunded_tiyn: number;
    timeline: number;
  }>(
    `SELECT
       (SELECT count(*)::int FROM tickets WHERE event_id = $1) AS tech_tickets,
       (SELECT count(*)::int FROM tickets WHERE event_id = $1 AND status = 'checked_in') AS tech_checked_in,
       (SELECT count(*)::int FROM promo_redemptions WHERE campaign_id = $2) AS redemptions,
       (SELECT count(*)::int FROM refunds r JOIN orders o ON o.id = r.order_id
         WHERE o.event_id = $3) AS refunds,
       (SELECT COALESCE(sum(r.amount), 0)::int FROM refunds r JOIN orders o ON o.id = r.order_id
         WHERE o.event_id = $3) AS refunded_tiyn,
       (SELECT count(*)::int FROM audit_log WHERE event_id = $3) AS timeline`,
    [EVENT_TECH_ID, CAMPAIGN_COMMUNITY_ID, EVENT_CANCELLED_ID],
  );
  const s = rows[0];
  const community = CAMPAIGNS[0];
  const jazzVip = CAMPAIGNS[1];

  console.log(
    `Demo data ready. New rows this run: ${inserted}${inserted === 0 ? ' (already seeded)' : ''}.`,
  );
  if (s && community && jazzVip) {
    console.log(
      `Astana Tech Meetup: ${s.tech_tickets} tickets sold, ${s.tech_checked_in} checked in.`,
    );
    console.log(`Promo ${community.code}: ${s.redemptions} redemptions.`);
    console.log(`  campaign link: /events/${EVENT_TECH_ID}?promo=${community.token}`);
    console.log(
      `Cancelled event (${EVENT_CANCELLED_ID}): ${s.refunds} refunded orders, ` +
        `${kzt(s.refunded_tiyn)} refunded, ${s.timeline} timeline entries.`,
    );
    console.log(`Hidden VIP ticket on Almaty Jazz Night is unlocked by promo ${jazzVip.code}.`);
  }
  console.log(`Try: GET /api/events/${EVENT_TECH_ID}`);
}

seed()
  .then(async (inserted) => {
    await printSummary(inserted);
    await pool.end();
  })
  .catch(async (err) => {
    console.error(err);
    await pool.end();
    process.exit(1);
  });
