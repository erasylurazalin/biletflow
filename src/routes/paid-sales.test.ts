/**
 * Tests for the paid sales activation endpoints. Same approach as ticket-types.test.ts:
 * the pool is faked, so the owner check, validation and the checklist rules run for real
 * but the SQL does not. The whole flow against a real database is in
 * paid-sales.db.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../db/pool', () => {
  const query = vi.fn();
  const clientQuery = vi.fn((sql: string, ...args: unknown[]) => {
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql.trim())) {
      return Promise.resolve({ rows: [] });
    }
    return query(sql, ...args);
  });
  return {
    pool: {
      query,
      connect: vi.fn(async () => ({ query: clientQuery, release: vi.fn() })),
    },
  };
});

import { pool } from '../db/pool';
import { createApp } from '../app';
import { signToken } from '../middleware/auth';

const query = vi.mocked(pool.query);
const app = createApp();

const ORGANIZER_ID = '11111111-1111-4111-8111-111111111111';
const STRANGER_ID = '22222222-2222-4222-8222-222222222222';
const EVENT_ID = '33333333-3333-4333-8333-333333333333';

const TERMS_AT = '2026-10-13T09:00:00.000Z';
const PAID_AT = '2026-10-13T09:05:00.000Z';
const ACTIVATED_AT = '2026-10-13T09:10:00.000Z';

// What loadOwnPaidSales() reads: a fresh event where only the organizer-level steps
// (paid type, identity, payout) are done.
const freshRow = {
  event_id: EVENT_ID,
  organizer_id: ORGANIZER_ID,
  event_status: 'draft',
  paid_ticket_type: true,
  identity_verified: true,
  payout_account: true,
  terms_accepted_at: null,
  activated_at: null,
  payment_amount: null,
  payment_currency: null,
  payment_method: null,
  payment_is_demonstration: null,
  payment_paid_at: null,
};

const feePaid = {
  payment_amount: 500000,
  payment_currency: 'KZT',
  payment_method: 'simulated',
  payment_is_demonstration: true,
  payment_paid_at: PAID_AT,
};

// Everything on the checklist done, not activated yet.
const readyRow = { ...freshRow, ...feePaid, terms_accepted_at: TERMS_AT };

function rows(value: unknown[]) {
  return { rows: value } as never;
}

function bearer(userId = ORGANIZER_ID) {
  return `Bearer ${signToken({ id: userId, role: 'organizer' })}`;
}

const statements = () => query.mock.calls.map((call) => String(call[0]).trim());

beforeEach(() => {
  query.mockReset();
  process.env.JWT_SECRET = 'test-jwt-secret';
});

describe('GET /api/events/:id/paid-sales', () => {
  it('returns the checklist in the docs/api.md shape', async () => {
    query.mockResolvedValueOnce(rows([freshRow]));

    const res = await request(app)
      .get(`/api/events/${EVENT_ID}/paid-sales`)
      .set('Authorization', bearer());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      paid_sales: {
        event_id: EVENT_ID,
        status: 'inactive',
        checklist: {
          paid_ticket_type: true,
          identity_verified: true,
          payout_account: true,
          activation_fee_paid: false,
          terms_accepted: false,
        },
        activation_fee: { amount: 500000, currency: 'KZT', payment: null },
        terms_accepted_at: null,
        activated_at: null,
      },
    });
  });

  it('labels the paid fee as a demonstration payment', async () => {
    query.mockResolvedValueOnce(rows([readyRow]));

    const res = await request(app)
      .get(`/api/events/${EVENT_ID}/paid-sales`)
      .set('Authorization', bearer());

    expect(res.body.paid_sales.activation_fee.payment).toEqual({
      method: 'simulated',
      is_demonstration: true,
      amount: 500000,
      currency: 'KZT',
      paid_at: PAID_AT,
    });
  });

  it("returns 403 on somebody else's event", async () => {
    query.mockResolvedValueOnce(rows([freshRow]));

    const res = await request(app)
      .get(`/api/events/${EVENT_ID}/paid-sales`)
      .set('Authorization', bearer(STRANGER_ID));

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('returns 404 when the event does not exist', async () => {
    query.mockResolvedValueOnce(rows([]));

    const res = await request(app)
      .get(`/api/events/${EVENT_ID}/paid-sales`)
      .set('Authorization', bearer());

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('EVENT_NOT_FOUND');
  });

  it('returns 401 without a token', async () => {
    const res = await request(app).get(`/api/events/${EVENT_ID}/paid-sales`);

    expect(res.status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('POST /api/events/:id/paid-sales/activation-fee', () => {
  const payFee = (userId = ORGANIZER_ID) =>
    request(app)
      .post(`/api/events/${EVENT_ID}/paid-sales/activation-fee`)
      .set('Authorization', bearer(userId));

  it('records a simulated payment of 5,000 KZT and its audit entry', async () => {
    const PAYMENT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    query
      .mockResolvedValueOnce(rows([freshRow]))
      .mockResolvedValueOnce(rows([{ id: PAYMENT_ID }]))
      .mockResolvedValueOnce(rows([]))
      .mockResolvedValueOnce(rows([{ ...freshRow, ...feePaid }]));

    const res = await payFee();

    expect(res.status).toBe(200);
    expect(res.body.paid_sales.checklist.activation_fee_paid).toBe(true);
    expect(statements()[1]).toContain("'activation_fee'");
    expect(statements()[1]).toContain("'simulated'");
    expect(query.mock.calls[1]?.[1]).toEqual([EVENT_ID, ORGANIZER_ID, 500000]);
    expect(query.mock.calls[2]?.[1]).toEqual([
      ORGANIZER_ID,
      'paid_sales.fee_paid',
      'payment',
      PAYMENT_ID,
      EVENT_ID,
      'Paid the simulated paid-sales activation fee of 5000 KZT',
    ]);
  });

  it('returns 409 CONFLICT when the fee is already paid and writes no audit entry', async () => {
    query
      .mockResolvedValueOnce(rows([readyRow]))
      .mockRejectedValueOnce(Object.assign(new Error('duplicate key'), { code: '23505' }));

    const res = await payFee();

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
    expect(statements().some((sql) => sql.includes('INSERT INTO audit_log'))).toBe(false);
  });

  it('returns 409 CONFLICT on a cancelled event and records nothing', async () => {
    query.mockResolvedValueOnce(rows([{ ...freshRow, event_status: 'cancelled' }]));

    const res = await payFee();

    expect(res.status).toBe(409);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("returns 403 on somebody else's event and records nothing", async () => {
    query.mockResolvedValueOnce(rows([freshRow]));

    const res = await payFee(STRANGER_ID);

    expect(res.status).toBe(403);
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/events/:id/paid-sales/terms', () => {
  it('records the acceptance and keeps the first one on a repeat', async () => {
    query
      .mockResolvedValueOnce(rows([freshRow]))
      .mockResolvedValueOnce(rows([]))
      .mockResolvedValueOnce(rows([{ ...freshRow, terms_accepted_at: TERMS_AT }]));

    const res = await request(app)
      .post(`/api/events/${EVENT_ID}/paid-sales/terms`)
      .set('Authorization', bearer())
      .send({ accepted: true });

    expect(res.status).toBe(200);
    expect(res.body.paid_sales.terms_accepted_at).toBe(TERMS_AT);
    expect(statements()[1]).toContain('COALESCE(psa.terms_accepted_at');
  });

  it.each([
    ['no body', undefined],
    ['accepted: false', { accepted: false }],
    ['accepted as a string', { accepted: 'yes' }],
  ])('returns 400 for %s, without touching the database', async (_label, body) => {
    const res = await request(app)
      .post(`/api/events/${EVENT_ID}/paid-sales/terms`)
      .set('Authorization', bearer())
      .send(body);

    expect(res.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('POST /api/events/:id/paid-sales/activate', () => {
  const activate = () =>
    request(app).post(`/api/events/${EVENT_ID}/paid-sales/activate`).set('Authorization', bearer());

  it('activates when every checklist item is done and writes one audit entry', async () => {
    query
      .mockResolvedValueOnce(rows([readyRow]))
      .mockResolvedValueOnce({ rows: [{ event_id: EVENT_ID }], rowCount: 1 } as never)
      .mockResolvedValueOnce(rows([]))
      .mockResolvedValueOnce(rows([{ ...readyRow, activated_at: ACTIVATED_AT }]));

    const res = await activate();

    expect(res.status).toBe(200);
    expect(res.body.paid_sales.status).toBe('active');
    expect(res.body.paid_sales.activated_at).toBe(ACTIVATED_AT);
    expect(statements()[1]).toMatch(/^UPDATE paid_sales_activations/);
    expect(query.mock.calls[2]?.[1]).toEqual([
      ORGANIZER_ID,
      'paid_sales.activated',
      'event',
      EVENT_ID,
      EVENT_ID,
      'Activated paid sales for the event',
    ]);
  });

  it('returns 409 PAID_SALES_INCOMPLETE and writes no audit entry', async () => {
    query.mockResolvedValueOnce(rows([{ ...freshRow, payout_account: false }]));

    const res = await activate();

    expect(res.status).toBe(409);
    expect(res.body.error).toEqual({
      code: 'PAID_SALES_INCOMPLETE',
      message:
        'Paid sales cannot be activated yet. Still missing: a payout account on your ' +
        'organizer profile, the activation fee, accepting the paid-event terms.',
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(statements().some((sql) => sql.includes('INSERT INTO audit_log'))).toBe(false);
  });

  it('refuses an event without a paid ticket type', async () => {
    query.mockResolvedValueOnce(rows([{ ...readyRow, paid_ticket_type: false }]));

    const res = await activate();

    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('a ticket type with a price');
  });

  it('answers 200 without an update or audit entry when already active', async () => {
    const active = { ...readyRow, activated_at: ACTIVATED_AT };
    query.mockResolvedValueOnce(rows([active])).mockResolvedValueOnce(rows([active]));

    const res = await activate();

    expect(res.status).toBe(200);
    expect(statements().some((s) => s.startsWith('UPDATE'))).toBe(false);
    expect(statements().some((sql) => sql.includes('INSERT INTO audit_log'))).toBe(false);
  });
});
