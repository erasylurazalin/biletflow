/**
 * Tests for the promo campaign endpoints with the pool faked, so validation,
 * ownership and the audit entries run for real but the SQL does not. The redemption
 * limit and the discount math need a real database and live in promo-codes.db.test.ts.
 *
 * The create and PATCH endpoints run in a transaction, so the fake hands out a client
 * too: BEGIN, COMMIT and ROLLBACK answer nothing and take no place in the queue.
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
const STRANGER_ID = '88888888-8888-4888-8888-888888888888';
const EVENT_ID = '33333333-3333-4333-8333-333333333333';
const CAMPAIGN_ID = '44444444-4444-4444-8444-444444444444';
const TYPE_ID = '55555555-5555-4555-8555-555555555555';

const CREATED_AT = '2026-10-20T10:00:00.000Z';
const TOKEN = 'a'.repeat(32);

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

// What the ownership check reads: this event belongs to the organizer.
const ownEvent = [{ organizer_id: ORGANIZER_ID }];

// What the INSERT or UPDATE returns.
const campaignRow = {
  id: CAMPAIGN_ID,
  event_id: EVENT_ID,
  name: 'Spring deal',
  code: 'SPRING25',
  token: TOKEN,
  discount_type: 'percent',
  discount_value: 20,
  starts_at: null,
  ends_at: null,
  max_redemptions: 100,
  ticket_type_ids: null,
  is_active: true,
  created_at: CREATED_AT,
};

// What the report query reads for a campaign nobody has used yet.
const emptyReport = [
  { redemptions: 0, orders: 0, tickets_sold: 0, gross_revenue: 0, discount_total: 0 },
];

describe('POST /api/events/:id/promo-campaigns', () => {
  const create = (body: Record<string, unknown>) =>
    request(app)
      .post(`/api/events/${EVENT_ID}/promo-campaigns`)
      .set('Authorization', bearer())
      .send(body);

  it('creates a campaign and writes the audit entry inside the transaction', async () => {
    answer(ownEvent, [campaignRow], [], emptyReport);

    const res = await create({
      name: 'Spring deal',
      discount_type: 'percent',
      discount_value: 20,
      max_redemptions: 100,
    });

    expect(res.status).toBe(201);
    expect(res.body.campaign).toEqual({
      ...campaignRow,
      link: `http://localhost:3001/events/${EVENT_ID}?promo=${TOKEN}`,
      redemptions: 0,
      orders: 0,
      tickets_sold: 0,
      gross_revenue: 0,
      discount_total: 0,
      net_revenue: 0,
    });
    expect(statements()).toContain('COMMIT');
    const audit = query.mock.calls.find((call) => sqlOf(call).startsWith('INSERT INTO audit_log'));
    expect(audit?.[1]).toEqual([
      ORGANIZER_ID,
      'promo_code.created',
      'promo_code',
      CAMPAIGN_ID,
      EVENT_ID,
      'Created promo code SPRING25 for "Spring deal"',
    ]);
  });

  it('refuses a percent discount outside 1 to 100 with 400 before any query', async () => {
    for (const discount_value of [0, 101]) {
      const res = await create({
        name: 'Spring deal',
        discount_type: 'percent',
        discount_value,
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message as string).toContain('discount_value');
    }
    expect(statements()).not.toContain('BEGIN');
  });

  it('refuses a fixed discount of 0 with 400', async () => {
    const res = await create({
      name: 'Spring deal',
      discount_type: 'fixed',
      discount_value: 0,
    });

    expect(res.status).toBe(400);
    expect(statements()).not.toContain('BEGIN');
  });

  it('refuses a code that is not 6 to 20 characters of A-Z and 0-9', async () => {
    for (const code of ['ab-cd', 'ABC', 'TOOLONGCODETOOLONGCODE', 'SP ACE12']) {
      const res = await create({
        name: 'Spring deal',
        discount_type: 'percent',
        discount_value: 20,
        code,
      });
      expect(res.status).toBe(400);
      expect(res.body.error.message as string).toContain('code');
    }
    expect(statements()).not.toContain('BEGIN');
  });

  it('refuses ticket types of another event with 400 and rolls back', async () => {
    answer(ownEvent, []);

    const res = await create({
      name: 'Spring deal',
      discount_type: 'percent',
      discount_value: 20,
      ticket_type_ids: [TYPE_ID],
    });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe(
      'Every ticket type of a campaign must belong to this event',
    );
    expect(statements()).toContain('ROLLBACK');
    expect(statements().some((s) => s.startsWith('INSERT INTO promo_campaigns'))).toBe(false);
  });

  it('returns 401 without a token', async () => {
    const res = await request(app).post(`/api/events/${EVENT_ID}/promo-campaigns`).send({});

    expect(res.status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });

  it('returns 403 when the event belongs to another organizer', async () => {
    answer([{ organizer_id: STRANGER_ID }]);

    const res = await create({
      name: 'Spring deal',
      discount_type: 'percent',
      discount_value: 20,
    });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('returns 404 EVENT_NOT_FOUND when the event does not exist', async () => {
    answer([]);

    const res = await create({
      name: 'Spring deal',
      discount_type: 'percent',
      discount_value: 20,
    });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('EVENT_NOT_FOUND');
  });
});

describe('GET /api/events/:id/promo-campaigns', () => {
  it('lists the campaigns in the envelope with the report numbers', async () => {
    answer(ownEvent, [campaignRow], emptyReport, []);

    const res = await request(app)
      .get(`/api/events/${EVENT_ID}/promo-campaigns?limit=5`)
      .set('Authorization', bearer());

    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(5);
    expect(res.body.offset).toBe(0);
    expect(res.body.campaigns).toHaveLength(1);
    expect(res.body.campaigns[0]).toMatchObject({
      code: 'SPRING25',
      redemptions: 0,
      net_revenue: 0,
    });
    expect(res.body.ticket_types).toEqual([]);
  });

  it('returns 403 for another organizer and 404 for a missing event', async () => {
    answer([{ organizer_id: STRANGER_ID }]);
    const forbidden = await request(app)
      .get(`/api/events/${EVENT_ID}/promo-campaigns`)
      .set('Authorization', bearer());
    expect(forbidden.status).toBe(403);

    answer([]);
    const missing = await request(app)
      .get(`/api/events/${EVENT_ID}/promo-campaigns`)
      .set('Authorization', bearer());
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('EVENT_NOT_FOUND');
  });
});

describe('PATCH /api/promo-campaigns/:id', () => {
  const disable = () =>
    request(app)
      .patch(`/api/promo-campaigns/${CAMPAIGN_ID}`)
      .set('Authorization', bearer())
      .send({ is_active: false });

  it('disables the campaign and writes the audit insert inside the transaction', async () => {
    answer(
      [{ ...campaignRow, organizer_id: ORGANIZER_ID }],
      [{ ...campaignRow, organizer_id: ORGANIZER_ID, is_active: false }],
      [],
      emptyReport,
    );

    const res = await disable();

    expect(res.status).toBe(200);
    expect(res.body.campaign.is_active).toBe(false);
    expect(statements()).toContain('COMMIT');
    const audit = query.mock.calls.find((call) => sqlOf(call).startsWith('INSERT INTO audit_log'));
    expect(audit?.[1]).toEqual([
      ORGANIZER_ID,
      'promo_code.disabled',
      'promo_code',
      CAMPAIGN_ID,
      EVENT_ID,
      'Disabled promo code SPRING25 for "Spring deal"',
    ]);
  });

  it('enables the campaign again without an audit entry', async () => {
    answer(
      [{ ...campaignRow, organizer_id: ORGANIZER_ID, is_active: false }],
      [{ ...campaignRow, organizer_id: ORGANIZER_ID }],
      emptyReport,
    );

    const res = await request(app)
      .patch(`/api/promo-campaigns/${CAMPAIGN_ID}`)
      .set('Authorization', bearer())
      .send({ is_active: true });

    expect(res.status).toBe(200);
    expect(res.body.campaign.is_active).toBe(true);
    expect(statements().some((s) => s.startsWith('INSERT INTO audit_log'))).toBe(false);
  });

  it('returns 403 for another organizer, 404 for a missing campaign', async () => {
    answer([{ ...campaignRow, organizer_id: STRANGER_ID }]);
    const forbidden = await disable();
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.code).toBe('FORBIDDEN');
    expect(statements().some((s) => s.startsWith('UPDATE promo_campaigns'))).toBe(false);

    answer([]);
    const missing = await disable();
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('PROMO_CAMPAIGN_NOT_FOUND');
    expect(statements().some((s) => s.startsWith('UPDATE promo_campaigns'))).toBe(false);
  });

  it('refuses a body without is_active', async () => {
    const res = await request(app)
      .patch(`/api/promo-campaigns/${CAMPAIGN_ID}`)
      .set('Authorization', bearer())
      .send({});

    expect(res.status).toBe(400);
    expect(statements()).not.toContain('BEGIN');
  });
});
