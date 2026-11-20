/**
 * Tests for GET /api/events/:id/analytics with the pool faked, so the ownership check,
 * the filter parsing and the arithmetic run for real but the SQL does not. The numbers
 * themselves, worked out by hand against a real database, live in
 * analytics.db.test.ts. Setup follows promo-campaigns.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../db/pool', () => {
  const query = vi.fn();
  return { pool: { query } };
});

import { pool } from '../db/pool';
import { createApp } from '../app';
import { signToken } from '../middleware/auth';

const query = vi.mocked(pool.query);
const app = createApp();

const ORGANIZER_ID = '11111111-1111-4111-8111-111111111111';
const STRANGER_ID = '88888888-8888-4888-8888-888888888888';
const EVENT_ID = '33333333-3333-4333-8333-333333333333';
const CAMPAIGN_ID = '44444444-4444-4444-8444-444444444444';
const EARLY_ID = '55555555-5555-4555-8555-555555555555';
const VIP_ID = '66666666-6666-4666-8666-666666666666';
const OTHER_TYPE_ID = '77777777-7777-4777-8777-777777777777';

const STARTS_AT = '2026-11-14T15:00:00.000Z';

let queue: unknown[][] = [];

// The answers to the next queries, in order: one array of rows per query. The handler
// asks for them in a fixed order: the event, its ticket types, then the five reads it
// runs together (money, items, attendance, days, campaigns) and one report per
// campaign.
function answer(...rows: unknown[][]) {
  queue.push(...rows);
}

beforeEach(() => {
  queue = [];
  query.mockReset();
  query.mockImplementation((async (sql: string) => {
    const rows = queue.shift();
    if (!rows) {
      throw new Error(`No answer queued for: ${String(sql).slice(0, 60)}`);
    }
    return { rows };
  }) as never);
  process.env.JWT_SECRET = 'test-jwt-secret';
});

function bearer(userId = ORGANIZER_ID) {
  return `Bearer ${signToken({ id: userId, role: 'organizer' })}`;
}

const ownEvent = [
  {
    id: EVENT_ID,
    title: 'Astana Tech Meetup',
    status: 'published',
    starts_at: STARTS_AT,
    organizer_id: ORGANIZER_ID,
  },
];

const earlyBird = {
  id: EARLY_ID,
  name: 'Early Bird',
  price: 500000,
  is_hidden: false,
  quantity_total: 10,
};
const vip = { id: VIP_ID, name: 'VIP', price: 1000000, is_hidden: true, quantity_total: 5 };

// The five reads, all empty: an event nobody has bought a ticket for yet.
function noActivity() {
  answer(ownEvent, [earlyBird], [{ gross: 0, discounts: 0, refunds: 0 }], [], [], [], []);
}

const get = (query_: Record<string, string> = {}, token = bearer()) =>
  request(app).get(`/api/events/${EVENT_ID}/analytics`).query(query_).set('Authorization', token);

describe('GET /api/events/:id/analytics', () => {
  it('needs a token', async () => {
    const res = await request(app).get(`/api/events/${EVENT_ID}/analytics`);

    expect(res.status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });

  it("is for the event's organizer only", async () => {
    answer(ownEvent);

    const res = await get({}, bearer(STRANGER_ID));

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('answers 404 for an event that does not exist', async () => {
    answer([]);

    const res = await get();

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('EVENT_NOT_FOUND');
  });

  it('rejects a date that does not exist', async () => {
    const res = await get({ from: '2026-02-31' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects a range that ends before it starts', async () => {
    const res = await get({ from: '2026-10-21', to: '2026-10-20' });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/earlier than "to"/);
  });

  it("rejects a ticket type that is not the event's", async () => {
    answer(ownEvent, []);

    const res = await get({ ticket_type_id: OTHER_TYPE_ID });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('reads zeros for an event with no activity, without dividing by zero', async () => {
    noActivity();

    const res = await get();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      event: {
        id: EVENT_ID,
        title: 'Astana Tech Meetup',
        status: 'published',
        starts_at: STARTS_AT,
      },
      filters: { from: null, to: null, ticket_type_id: null },
      sales: { capacity: 10, held: 0, sold: 0, remaining: 10, percent_sold: 0 },
      revenue: {
        currency: 'KZT',
        is_demonstration: true,
        gross: 0,
        discounts: 0,
        refunds: 0,
        net: 0,
      },
      by_ticket_type: [
        {
          ticket_type_id: EARLY_ID,
          name: 'Early Bird',
          price: 500000,
          is_hidden: false,
          capacity: 10,
          sold: 0,
          remaining: 10,
          gross: 0,
          registered: 0,
          checked_in: 0,
          absent: 0,
        },
      ],
      check_in: { registered: 0, checked_in: 0, absent: 0, percent: 0 },
      over_time: [],
      campaigns: [],
    });
  });

  it('adds an event up and keeps the fee out of revenue', async () => {
    answer(
      ownEvent,
      [earlyBird, vip],
      // Two paid orders and one refunded: gross 25000 ₸, 1000 ₸ discounted, 10000 ₸
      // refunded, so net is 14000 ₸. The 300 ₸ and 120 ₸ processing fees are in none
      // of these numbers.
      [{ gross: 2500000, discounts: 100000, refunds: 1000000 }],
      [
        { ticket_type_id: EARLY_ID, sold: 3, held: 1, gross: 1500000 },
        { ticket_type_id: VIP_ID, sold: 0, held: 0, gross: 1000000 },
      ],
      [
        { ticket_type_id: EARLY_ID, registered: 3, checked_in: 1 },
        { ticket_type_id: VIP_ID, registered: 0, checked_in: 0 },
      ],
      [
        {
          date: '2026-10-20',
          orders: 3,
          tickets: 6,
          gross: 2500000,
          discounts: 100000,
        },
      ],
      [],
    );

    const res = await get({ from: '2026-10-20', to: '2026-10-21' });

    expect(res.status).toBe(200);
    expect(res.body.filters).toEqual({
      from: '2026-10-20',
      to: '2026-10-21',
      ticket_type_id: null,
    });
    // 15 seats, 3 sold, 1 held by a pending order.
    expect(res.body.sales).toEqual({
      capacity: 15,
      held: 1,
      sold: 3,
      remaining: 12,
      percent_sold: 20,
    });
    expect(res.body.revenue).toEqual({
      currency: 'KZT',
      is_demonstration: true,
      gross: 2500000,
      discounts: 100000,
      refunds: 1000000,
      net: 1400000,
    });
    // One of three tickets scanned: 33.3%, and the refunded VIP leaves no attendance.
    expect(res.body.check_in).toEqual({
      registered: 3,
      checked_in: 1,
      absent: 2,
      percent: 33.3,
    });
    expect(res.body.by_ticket_type).toEqual([
      {
        ticket_type_id: EARLY_ID,
        name: 'Early Bird',
        price: 500000,
        is_hidden: false,
        capacity: 10,
        sold: 3,
        remaining: 7,
        gross: 1500000,
        registered: 3,
        checked_in: 1,
        absent: 2,
      },
      {
        ticket_type_id: VIP_ID,
        name: 'VIP',
        price: 1000000,
        is_hidden: true,
        capacity: 5,
        sold: 0,
        remaining: 5,
        gross: 1000000,
        registered: 0,
        checked_in: 0,
        absent: 0,
      },
    ]);
    // The day's net is gross minus discounts: refunds are not bucketed by day.
    expect(res.body.over_time).toEqual([
      {
        date: '2026-10-20',
        orders: 3,
        tickets: 6,
        gross: 2500000,
        discounts: 100000,
        net: 2400000,
      },
    ]);
  });

  it('narrows to one ticket type and keeps the campaigns that cover it', async () => {
    answer(
      ownEvent,
      [{ ...earlyBird }],
      [{ gross: 500000, discounts: 100000, refunds: 0 }],
      [{ ticket_type_id: EARLY_ID, sold: 1, held: 0, gross: 500000 }],
      [{ ticket_type_id: EARLY_ID, registered: 1, checked_in: 0 }],
      [],
      [{ id: CAMPAIGN_ID, name: 'Spring deal', code: 'SPRING25', is_active: true }],
      // The campaign report, from lib/campaigns.ts, unchanged by the filters.
      [
        {
          redemptions: 1,
          orders: 1,
          tickets_sold: 1,
          gross_revenue: 500000,
          discount_total: 100000,
        },
      ],
    );

    const res = await get({ ticket_type_id: EARLY_ID });

    expect(res.status).toBe(200);
    expect(res.body.sales).toEqual({
      capacity: 10,
      held: 0,
      sold: 1,
      remaining: 9,
      percent_sold: 10,
    });
    expect(res.body.revenue.net).toBe(400000);
    expect(res.body.campaigns).toEqual([
      {
        id: CAMPAIGN_ID,
        name: 'Spring deal',
        code: 'SPRING25',
        is_active: true,
        redemptions: 1,
        orders: 1,
        tickets_sold: 1,
        gross_revenue: 500000,
        discount_total: 100000,
        net_revenue: 400000,
      },
    ]);
  });
});
