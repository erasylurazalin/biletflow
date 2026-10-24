/**
 * Tests for the order endpoints with the pool faked, so validation, ownership and the
 * error codes run for real but the SQL does not. The race (two buyers, one seat) needs
 * a real database and lives in orders.db.test.ts.
 *
 * Orders run in a transaction, so the fake hands out a client too. Both share one
 * `query` mock that answers from a queue, and BEGIN, COMMIT and ROLLBACK answer
 * nothing without taking a place in it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../db/pool', () => {
  const query = vi.fn();
  return { pool: { query, connect: vi.fn(async () => ({ query, release: vi.fn() })) } };
});

import { pool } from '../db/pool';
import { createApp } from '../app';
import { signToken } from '../middleware/auth';

const query = vi.mocked(pool.query);
const app = createApp();

const BUYER_ID = '22222222-2222-4222-8222-222222222222';
const STRANGER_ID = '88888888-8888-4888-8888-888888888888';
const EVENT_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_EVENT_ID = '44444444-4444-4444-8444-444444444444';
const TT_EARLY_ID = '55555555-5555-4555-8555-555555555555';
const TT_STUDENT_ID = '66666666-6666-4666-8666-666666666666';
const ORDER_ID = '99999999-9999-4999-8999-999999999999';

const CREATED_AT = '2026-10-13T10:00:00.000Z';
const EXPIRES_AT = '2026-10-13T10:10:00.000Z';

let queue: unknown[][] = [];

// The answers to the next queries, in order: one array of rows per query.
function answer(...rows: unknown[][]) {
  queue.push(...rows);
}

function sqlOf(call: unknown[]): string {
  return String(call[0]).trim();
}

const statements = () => query.mock.calls.map(sqlOf);

beforeEach(() => {
  queue = [];
  query.mockReset();
  query.mockImplementation((async (sql: string) => {
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql.trim())) {
      return { rows: [] };
    }
    const rows = queue.shift();
    if (!rows) {
      throw new Error(`No answer queued for: ${sql.slice(0, 60)}`);
    }
    return { rows };
  }) as never);
  process.env.JWT_SECRET = 'test-jwt-secret';
});

function bearer(userId = BUYER_ID) {
  return `Bearer ${signToken({ id: userId, role: 'attendee' })}`;
}

const lockedEarly = {
  id: TT_EARLY_ID,
  event_id: EVENT_ID,
  name: 'Early Bird',
  price: 500000,
  is_hidden: false,
  on_sale: true,
};
const lockedStudent = { ...lockedEarly, id: TT_STUDENT_ID, name: 'Student', price: 0 };

// What POST /api/orders reads about the event: paid sales on, unless a test says not.
const activeEvent = [{ status: 'published', paid_sales_active: true }];
const inactiveEvent = [{ status: 'published', paid_sales_active: false }];

// No payment yet: the LEFT JOIN on payments found nothing.
const noPayment = {
  payment_amount: null,
  payment_currency: null,
  payment_method: null,
  payment_is_demonstration: null,
  payment_paid_at: null,
};

const PAID_AT = '2026-10-13T10:05:00.000Z';

const orderRow = {
  id: ORDER_ID,
  status: 'pending',
  event_id: EVENT_ID,
  event_title: 'Astana Tech Meetup',
  subtotal: 1000000,
  discount: 0,
  processing_fee: 30000,
  total: 1030000,
  created_at: CREATED_AT,
  expires_at: EXPIRES_AT,
  ...noPayment,
};
const itemRows = [
  {
    order_id: ORDER_ID,
    ticket_type_id: TT_EARLY_ID,
    name: 'Early Bird',
    quantity: 2,
    unit_price: 500000,
  },
];

// What loadOrder() reads after a write: the order, its items, its tickets.
function answerLoadOrder(order = orderRow, tickets: unknown[] = []) {
  answer([order], itemRows, tickets);
}

describe('POST /api/orders', () => {
  const body = { event_id: EVENT_ID, items: [{ ticket_type_id: TT_EARLY_ID, quantity: 2 }] };

  it('holds the seats as a pending order and answers 201 with the order', async () => {
    answer(
      activeEvent,
      [lockedEarly],
      [{ id: TT_EARLY_ID, available: 10 }],
      [{ id: ORDER_ID }],
      [],
    );
    answerLoadOrder();

    const res = await request(app).post('/api/orders').set('Authorization', bearer()).send(body);

    expect(res.status).toBe(201);
    expect(res.body.order).toEqual({
      id: ORDER_ID,
      status: 'pending',
      event: { id: EVENT_ID, title: 'Astana Tech Meetup' },
      items: [{ ticket_type_id: TT_EARLY_ID, name: 'Early Bird', quantity: 2, unit_price: 500000 }],
      subtotal: 1000000,
      discount: 0,
      processing_fee: 30000,
      total: 1030000,
      created_at: CREATED_AT,
      expires_at: EXPIRES_AT,
      payment: null,
      tickets: [],
    });
    // Prices come from the locked rows: subtotal 2 x 500000, plus a 3% fee.
    const insert = query.mock.calls.find((call) => sqlOf(call).startsWith('INSERT INTO orders'));
    expect(insert?.[1]).toEqual([BUYER_ID, EVENT_ID, 1000000, 0, 30000, 1030000]);
    // The ticket types are locked before anything is counted.
    expect(statements().findIndex((s) => s.includes('FOR UPDATE'))).toBeLessThan(
      statements().findIndex((s) => s.includes('AS available')),
    );
    expect(statements()).toContain('COMMIT');
    // The hold is 15 minutes (docs/decisions.md).
    expect(sqlOf(insert!)).toContain("interval '15 minutes'");
  });

  it('returns 401 without a token', async () => {
    const res = await request(app).post('/api/orders').send(body);

    expect(res.status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });

  it.each([
    ['no items', { event_id: EVENT_ID, items: [] }],
    [
      'a quantity of 0',
      { event_id: EVENT_ID, items: [{ ticket_type_id: TT_EARLY_ID, quantity: 0 }] },
    ],
    [
      'more than 10 of one type',
      { event_id: EVENT_ID, items: [{ ticket_type_id: TT_EARLY_ID, quantity: 11 }] },
    ],
    [
      'more than 10 tickets across types',
      {
        event_id: EVENT_ID,
        items: [
          { ticket_type_id: TT_EARLY_ID, quantity: 6 },
          { ticket_type_id: TT_STUDENT_ID, quantity: 5 },
        ],
      },
    ],
    [
      'the same ticket type twice',
      {
        event_id: EVENT_ID,
        items: [
          { ticket_type_id: TT_EARLY_ID, quantity: 1 },
          { ticket_type_id: TT_EARLY_ID, quantity: 1 },
        ],
      },
    ],
    [
      'attendee names that do not match the quantity',
      {
        event_id: EVENT_ID,
        items: [{ ticket_type_id: TT_EARLY_ID, quantity: 2, attendee_names: ['Aru'] }],
      },
    ],
    ['an event id that is not a UUID', { ...body, event_id: 'banana' }],
  ])('returns 400 for %s, without touching the database', async (_label, invalid) => {
    const res = await request(app).post('/api/orders').set('Authorization', bearer()).send(invalid);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(query).not.toHaveBeenCalled();
  });

  it('accepts exactly 10 tickets across types', async () => {
    answer(
      activeEvent,
      [lockedEarly, lockedStudent],
      [
        { id: TT_EARLY_ID, available: 10 },
        { id: TT_STUDENT_ID, available: 10 },
      ],
      [{ id: ORDER_ID }],
      [],
    );
    answerLoadOrder();

    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', bearer())
      .send({
        event_id: EVENT_ID,
        items: [
          { ticket_type_id: TT_EARLY_ID, quantity: 6 },
          { ticket_type_id: TT_STUDENT_ID, quantity: 4 },
        ],
      });

    expect(res.status).toBe(201);
  });

  it.each([
    ['does not exist', []],
    ['is a draft', [{ status: 'draft' }]],
  ])('returns 404 EVENT_NOT_FOUND when the event %s', async (_label, eventRows) => {
    answer(eventRows);

    const res = await request(app).post('/api/orders').set('Authorization', bearer()).send(body);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('EVENT_NOT_FOUND');
    expect(statements()).toContain('ROLLBACK');
  });

  it('returns 409 PAID_SALES_INACTIVE for a paid type before activation, and writes nothing', async () => {
    answer(inactiveEvent, [lockedEarly]);

    const res = await request(app).post('/api/orders').set('Authorization', bearer()).send(body);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PAID_SALES_INACTIVE');
    expect(statements().some((s) => s.startsWith('INSERT'))).toBe(false);
    expect(statements()).toContain('ROLLBACK');
  });

  it('still sells free types on an event whose paid sales are not active', async () => {
    answer(
      inactiveEvent,
      [lockedStudent],
      [{ id: TT_STUDENT_ID, available: 50 }],
      [{ id: ORDER_ID }],
      [],
    );
    answerLoadOrder({ ...orderRow, subtotal: 0, processing_fee: 0, total: 0 });

    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', bearer())
      .send({ event_id: EVENT_ID, items: [{ ticket_type_id: TT_STUDENT_ID, quantity: 1 }] });

    expect(res.status).toBe(201);
    expect(res.body.order).toMatchObject({ subtotal: 0, processing_fee: 0, total: 0 });
    const insert = query.mock.calls.find((call) => sqlOf(call).startsWith('INSERT INTO orders'));
    expect(insert?.[1]).toEqual([BUYER_ID, EVENT_ID, 0, 0, 0, 0]);
  });

  it('returns 409 CONFLICT for a cancelled event', async () => {
    answer([{ status: 'cancelled' }]);

    const res = await request(app).post('/api/orders').set('Authorization', bearer()).send(body);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it.each([
    ['does not exist', []],
    ['belongs to another event', [{ ...lockedEarly, event_id: OTHER_EVENT_ID }]],
    ['is hidden', [{ ...lockedEarly, is_hidden: true }]],
  ])('returns 400 when the ticket type %s', async (_label, typeRows) => {
    answer(activeEvent, typeRows);

    const res = await request(app).post('/api/orders').set('Authorization', bearer()).send(body);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 409 SALES_CLOSED outside the sales window', async () => {
    answer(activeEvent, [{ ...lockedEarly, on_sale: false }]);

    const res = await request(app).post('/api/orders').set('Authorization', bearer()).send(body);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SALES_CLOSED');
  });

  it.each([
    [0, '"Early Bird" is sold out'],
    [1, 'Only 1 "Early Bird" ticket is left'],
  ])('returns 409 TICKET_SOLD_OUT with %i left and writes nothing', async (available, message) => {
    answer(activeEvent, [lockedEarly], [{ id: TT_EARLY_ID, available }]);

    const res = await request(app).post('/api/orders').set('Authorization', bearer()).send(body);

    expect(res.status).toBe(409);
    expect(res.body.error).toEqual({ code: 'TICKET_SOLD_OUT', message });
    expect(statements().some((s) => s.startsWith('INSERT'))).toBe(false);
    expect(statements()).toContain('ROLLBACK');
  });
});

describe('POST /api/orders/:id/pay', () => {
  const pay = () => request(app).post(`/api/orders/${ORDER_ID}/pay`).set('Authorization', bearer());

  const paidOrderRow = {
    ...orderRow,
    status: 'paid',
    expires_at: null as never,
    payment_amount: 1030000,
    payment_currency: 'KZT',
    payment_method: 'simulated',
    payment_is_demonstration: true,
    payment_paid_at: PAID_AT,
  };

  it('marks the order paid, records a demonstration payment and issues one ticket per seat', async () => {
    answer(
      [
        {
          status: 'pending',
          event_id: EVENT_ID,
          event_title: 'Astana Tech Meetup',
          total: 1030000,
        },
      ],
      [
        {
          id: 'item',
          ticket_type_id: TT_EARLY_ID,
          name: 'Early Bird',
          quantity: 2,
          attendee_names: null,
        },
      ],
      [],
      [{ expired: false }],
      [],
      [],
      [{ name: 'Aidos K.', email: 'buyer@example.kz' }],
      [],
      [],
      [],
    );
    answerLoadOrder(paidOrderRow as never);

    const res = await pay();

    expect(res.status).toBe(200);
    expect(res.body.order.status).toBe('paid');
    expect(res.body.order.payment).toEqual({
      method: 'simulated',
      is_demonstration: true,
      amount: 1030000,
      currency: 'KZT',
      paid_at: PAID_AT,
    });
    const payment = query.mock.calls.find((call) => sqlOf(call).startsWith('INSERT INTO payments'));
    expect(payment?.[1]).toEqual([ORDER_ID, BUYER_ID, 1030000]);
    const insert = query.mock.calls.find((call) => sqlOf(call).startsWith('INSERT INTO tickets'));
    const [eventId, itemIds, typeIds, codes, names] = insert![1] as unknown[];
    expect(eventId).toBe(EVENT_ID);
    expect(itemIds).toEqual(['item', 'item']);
    expect(typeIds).toEqual([TT_EARLY_ID, TT_EARLY_ID]);
    expect(codes).toHaveLength(2);
    expect(names).toEqual(['Aidos K.', 'Aidos K.']);
    for (const code of codes as string[]) {
      expect(code).toMatch(/^BF-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    }
    const audit = query.mock.calls.find((call) => sqlOf(call).startsWith('INSERT INTO audit_log'));
    expect(audit?.[1]).toEqual([
      BUYER_ID,
      'order.paid',
      'order',
      ORDER_ID,
      EVENT_ID,
      'Paid 2 tickets, 10300.00 KZT (simulated)',
    ]);
    const email = query.mock.calls.find((call) =>
      sqlOf(call).startsWith('INSERT INTO email_outbox'),
    );
    expect(email?.[1]).toEqual([
      BUYER_ID,
      'buyer@example.kz',
      'order_confirmation',
      'Your tickets for Astana Tech Meetup',
      `${(codes as string[])[0]}  Early Bird  Aidos K.\n${(codes as string[])[1]}  Early Bird  Aidos K.\nSee them with their QR codes: http://localhost:3001/tickets\nSimulated payment: 10300.00 KZT. No real money was charged.`,
    ]);
  });

  it('records no payment for a free order', async () => {
    answer(
      [{ status: 'pending', event_id: EVENT_ID, event_title: 'Astana Tech Meetup', total: 0 }],
      [
        {
          id: 'item',
          ticket_type_id: TT_STUDENT_ID,
          name: 'Student',
          quantity: 1,
          attendee_names: null,
        },
      ],
      [],
      [{ expired: false }],
      [],
      [{ name: 'Aidos K.', email: 'buyer@example.kz' }],
      [],
      [],
      [],
    );
    answerLoadOrder({ ...orderRow, status: 'paid', subtotal: 0, processing_fee: 0, total: 0 });

    const res = await pay();

    expect(res.status).toBe(200);
    expect(res.body.order.payment).toBeNull();
    expect(statements().some((s) => s.startsWith('INSERT INTO payments'))).toBe(false);
  });

  it("returns 404 ORDER_NOT_FOUND for somebody else's order", async () => {
    answer([]);

    const res = await request(app)
      .post(`/api/orders/${ORDER_ID}/pay`)
      .set('Authorization', bearer(STRANGER_ID));

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ORDER_NOT_FOUND');
    expect(query.mock.calls.find((call) => sqlOf(call).includes('FOR UPDATE'))?.[1]).toEqual([
      ORDER_ID,
      STRANGER_ID,
    ]);
  });

  it('returns 409 CONFLICT for an order that is already paid', async () => {
    answer([{ status: 'paid', event_id: EVENT_ID }]);

    const res = await pay();

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('returns 409 ORDER_EXPIRED and issues nothing after the hold ran out', async () => {
    answer(
      [{ status: 'pending', event_id: EVENT_ID, total: 1000000 }],
      [{ id: 'item', ticket_type_id: TT_EARLY_ID, quantity: 2 }],
      [],
      [{ expired: true }],
    );

    const res = await pay();

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ORDER_EXPIRED');
    expect(statements().some((s) => s.startsWith('INSERT INTO tickets'))).toBe(false);
    expect(statements().some((s) => s.startsWith('INSERT INTO payments'))).toBe(false);
    expect(statements()).toContain('ROLLBACK');
  });
});

describe('GET /api/orders', () => {
  it('lists my orders in the envelope, without tickets', async () => {
    answer([orderRow], itemRows);

    const res = await request(app).get('/api/orders?limit=5').set('Authorization', bearer());

    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(5);
    expect(res.body.offset).toBe(0);
    expect(res.body.orders).toHaveLength(1);
    expect(res.body.orders[0].items).toHaveLength(1);
    expect(res.body.orders[0]).not.toHaveProperty('tickets');
    expect(query.mock.calls[0]?.[1]).toEqual([BUYER_ID, 5, 0]);
  });

  it('returns 400 for a limit above 100', async () => {
    const res = await request(app).get('/api/orders?limit=101').set('Authorization', bearer());

    expect(res.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('GET /api/orders/:id', () => {
  it("returns 404 ORDER_NOT_FOUND for somebody else's order", async () => {
    answer([]);

    const res = await request(app)
      .get(`/api/orders/${ORDER_ID}`)
      .set('Authorization', bearer(STRANGER_ID));

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ORDER_NOT_FOUND');
  });

  it('returns 400 when the id is not a UUID', async () => {
    const res = await request(app).get('/api/orders/banana').set('Authorization', bearer());

    expect(res.status).toBe(400);
  });
});
