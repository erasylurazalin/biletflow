/**
 * Tests for the organizer order endpoints with the pool faked, so ownership, the
 * status rules and the error codes run for real but the SQL does not. The concurrency
 * rule (two refunds, one order) needs a real database and lives in
 * refunds.db.test.ts.
 *
 * Both write endpoints run in a transaction, so the fake hands out a client too.
 * BEGIN, COMMIT and ROLLBACK, and the lock on the order's tickets, answer nothing
 * without taking a place in the queue.
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

const ORGANIZER_ID = '11111111-1111-4111-8111-111111111111';
const BUYER_ID = '22222222-2222-4222-8222-222222222222';
const STRANGER_ID = '88888888-8888-4888-8888-888888888888';
const EVENT_ID = '33333333-3333-4333-8333-333333333333';
const ORDER_ID = '99999999-9999-4999-8999-999999999999';

const CREATED_AT = '2026-10-20T10:00:00.000Z';
const REFUNDED_AT = '2026-10-22T09:00:00.000Z';

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
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql.trim()) || /FOR UPDATE OF t\b/.test(sql)) {
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

function bearer(userId = ORGANIZER_ID) {
  return `Bearer ${signToken({ id: userId, role: 'organizer' })}`;
}

// What loadOwnEvent() reads: this event belongs to the organizer, with a policy.
const ownEvent = [
  {
    organizer_id: ORGANIZER_ID,
    title: 'Astana Tech Meetup',
    refund_policy: 'Full refunds until the event starts.',
  },
];

// What the locked order read inside the transaction says for a paid order.
const paidOrder = {
  status: 'paid',
  total: 1030000,
  user_id: BUYER_ID,
  buyer_email: 'buyer@example.kz',
  checked_in_count: 0,
  ticket_count: 2,
};

// What loadOrganizerOrder() reads after a write.
const refundedOrderRow = {
  id: ORDER_ID,
  status: 'refunded',
  subtotal: 1000000,
  discount: 0,
  processing_fee: 30000,
  total: 1030000,
  created_at: CREATED_AT,
  buyer_id: BUYER_ID,
  buyer_name: 'Aidos K.',
  buyer_email: 'buyer@example.kz',
  ticket_count: 2,
  checked_in_count: 0,
  refund_amount: 1030000,
  refund_currency: 'KZT',
  refund_is_demonstration: true,
  refund_paid_at: REFUNDED_AT,
};

function answerRefundedLoad() {
  answer([refundedOrderRow]);
}

describe('GET /api/events/:id/orders', () => {
  it('lists the event orders in the envelope, newest first', async () => {
    answer(ownEvent, [refundedOrderRow]);

    const res = await request(app)
      .get(`/api/events/${EVENT_ID}/orders?limit=5`)
      .set('Authorization', bearer());

    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(5);
    expect(res.body.offset).toBe(0);
    expect(res.body.orders).toEqual([
      {
        id: ORDER_ID,
        status: 'refunded',
        buyer: { id: BUYER_ID, name: 'Aidos K.', email: 'buyer@example.kz' },
        subtotal: 1000000,
        discount: 0,
        processing_fee: 30000,
        total: 1030000,
        ticket_count: 2,
        checked_in_count: 0,
        created_at: CREATED_AT,
        refund: {
          amount: 1030000,
          currency: 'KZT',
          is_demonstration: true,
          refunded_at: REFUNDED_AT,
        },
      },
    ]);
  });

  it('reads refund: null for an order that was not refunded', async () => {
    answer(ownEvent, [
      {
        ...refundedOrderRow,
        status: 'paid',
        refund_amount: null,
        refund_currency: null,
        refund_is_demonstration: null,
        refund_paid_at: null,
      },
    ]);

    const res = await request(app)
      .get(`/api/events/${EVENT_ID}/orders`)
      .set('Authorization', bearer());

    expect(res.status).toBe(200);
    expect(res.body.orders[0].refund).toBeNull();
    expect(res.body.orders[0].status).toBe('paid');
  });

  it('returns 401 without a token', async () => {
    const res = await request(app).get(`/api/events/${EVENT_ID}/orders`);

    expect(res.status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });

  it("returns 403 for another organizer's event", async () => {
    answer([{ ...ownEvent[0], organizer_id: STRANGER_ID }]);

    const res = await request(app)
      .get(`/api/events/${EVENT_ID}/orders`)
      .set('Authorization', bearer());

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('returns 404 EVENT_NOT_FOUND when the event does not exist', async () => {
    answer([]);

    const res = await request(app)
      .get(`/api/events/${EVENT_ID}/orders`)
      .set('Authorization', bearer());

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('EVENT_NOT_FOUND');
  });
});

describe('POST /api/events/:id/orders/:orderId/refund', () => {
  const refund = () =>
    request(app)
      .post(`/api/events/${EVENT_ID}/orders/${ORDER_ID}/refund`)
      .set('Authorization', bearer());

  it('refunds the order and writes the refunds row, the audit entry and the email', async () => {
    answer(ownEvent, [paidOrder], [], [], [], [], []);
    answerRefundedLoad();

    const res = await refund();

    expect(res.status).toBe(200);
    expect(res.body.order.status).toBe('refunded');
    expect(res.body.order.refund).toEqual({
      amount: 1030000,
      currency: 'KZT',
      is_demonstration: true,
      refunded_at: REFUNDED_AT,
    });
    // The order row is locked before anything is checked or changed.
    expect(statements().findIndex((s) => s.includes('FOR UPDATE'))).toBeLessThan(
      statements().findIndex((s) => s.startsWith('UPDATE orders')),
    );
    expect(statements()).toContain('COMMIT');
    expect(statements().some((s) => s.startsWith('INSERT INTO refunds'))).toBe(true);
    const audit = query.mock.calls.find((call) => sqlOf(call).startsWith('INSERT INTO audit_log'));
    expect(audit?.[1]).toEqual([
      ORGANIZER_ID,
      'order.refunded',
      'order',
      ORDER_ID,
      EVENT_ID,
      'Refunded 10300.00 KZT (simulated)',
    ]);
    const email = query.mock.calls.find((call) =>
      sqlOf(call).startsWith('INSERT INTO email_outbox'),
    );
    expect(email?.[1]).toEqual([
      BUYER_ID,
      'buyer@example.kz',
      'refund_completed',
      'Your refund for Astana Tech Meetup',
      'Your refund for Astana Tech Meetup is complete: 10300.00 KZT.\nThis is a simulated refund for the academic MVP. No real money moves.\nRefund policy: Full refunds until the event starts.',
    ]);
  });

  it('returns 401 without a token', async () => {
    const res = await request(app).post(`/api/events/${EVENT_ID}/orders/${ORDER_ID}/refund`);

    expect(res.status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });

  it('returns 403 when the event belongs to another organizer', async () => {
    answer([{ ...ownEvent[0], organizer_id: STRANGER_ID }]);

    const res = await refund();

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(statements()).not.toContain('BEGIN');
  });

  it('returns 404 EVENT_NOT_FOUND when the event does not exist', async () => {
    answer([]);

    const res = await refund();

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('EVENT_NOT_FOUND');
    expect(statements()).not.toContain('BEGIN');
  });

  it('returns 404 ORDER_NOT_FOUND for an order of another event', async () => {
    answer(ownEvent, []);

    const res = await refund();

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ORDER_NOT_FOUND');
    expect(statements()).toContain('ROLLBACK');
  });

  it('returns 409 CONFLICT for an order that is not paid', async () => {
    answer(ownEvent, [{ ...paidOrder, status: 'refunded' }]);

    const res = await refund();

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
    expect(statements().some((s) => s.startsWith('UPDATE orders'))).toBe(false);
    expect(statements().some((s) => s.startsWith('INSERT INTO refunds'))).toBe(false);
    expect(statements()).toContain('ROLLBACK');
  });

  it('returns 409 CONFLICT for a free registration, pointing at cancel', async () => {
    answer(ownEvent, [{ ...paidOrder, total: 0 }]);

    const res = await refund();

    expect(res.status).toBe(409);
    expect(res.body.error.message).toBe(
      'This order is a free registration. Cancel it instead of refunding it.',
    );
    expect(statements().some((s) => s.startsWith('UPDATE orders'))).toBe(false);
  });

  it('returns 409 CONFLICT when a ticket of the order was used at the door', async () => {
    answer(ownEvent, [{ ...paidOrder, checked_in_count: 1 }]);

    const res = await refund();

    expect(res.status).toBe(409);
    expect(res.body.error.message).toBe('Some tickets of this order were already used at the door');
    expect(statements().some((s) => s.startsWith('UPDATE orders'))).toBe(false);
    expect(statements()).toContain('ROLLBACK');
  });
});

describe('POST /api/events/:id/orders/:orderId/cancel', () => {
  const cancel = () =>
    request(app)
      .post(`/api/events/${EVENT_ID}/orders/${ORDER_ID}/cancel`)
      .set('Authorization', bearer());

  it('cancels a free registration and writes the audit entry and the email', async () => {
    answer(ownEvent, [{ ...paidOrder, total: 0 }], [], [], [], []);
    answer([refundedOrderRow]);

    const res = await cancel();

    expect(res.status).toBe(200);
    expect(statements()).toContain('COMMIT');
    const audit = query.mock.calls.find((call) => sqlOf(call).startsWith('INSERT INTO audit_log'));
    expect(audit?.[1]).toEqual([
      ORGANIZER_ID,
      'order.cancelled',
      'order',
      ORDER_ID,
      EVENT_ID,
      'Cancelled a free registration of 2 tickets',
    ]);
    const email = query.mock.calls.find((call) =>
      sqlOf(call).startsWith('INSERT INTO email_outbox'),
    );
    expect(email?.[1]).toEqual([
      BUYER_ID,
      'buyer@example.kz',
      'registration_cancelled',
      'Your registration for Astana Tech Meetup was cancelled',
      'Your free registration for Astana Tech Meetup was cancelled by the organizer.\nIts 2 tickets are no longer valid.',
    ]);
    // A cancel writes no refunds row.
    expect(statements().some((s) => s.startsWith('INSERT INTO refunds'))).toBe(false);
  });

  it('returns 409 CONFLICT for a paid order, pointing at refund', async () => {
    answer(ownEvent, [paidOrder]);

    const res = await cancel();

    expect(res.status).toBe(409);
    expect(res.body.error.message).toBe('This order was paid. Refund it instead of cancelling it.');
    expect(statements().some((s) => s.startsWith('UPDATE orders'))).toBe(false);
    expect(statements()).toContain('ROLLBACK');
  });
});
