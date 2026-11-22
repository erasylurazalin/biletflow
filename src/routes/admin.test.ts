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
import type { AuthUser } from '../middleware/auth';
import { toCsv } from './admin';

const query = vi.mocked(pool.query);
const app = createApp();

const ADMIN_ID = '99999999-9999-4999-8999-999999999999';
const ORGANIZER_ID = '11111111-1111-4111-8111-111111111111';
const EVENT_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const REPORT_ID = '44444444-4444-4444-8444-444444444444';
const ORDER_ID = '55555555-5555-4555-8555-555555555555';
const SETTINGS_ID = '66666666-6666-4666-8666-666666666666';

const SUSPENDED_AT = new Date('2026-10-25T12:00:00.000Z');

const liveEvent = {
  id: EVENT_ID,
  title: 'Test event',
  status: 'published',
  suspended_at: null,
};
const suspendedEvent = { ...liveEvent, suspended_at: SUSPENDED_AT };

function rows(value: unknown[]) {
  return { rows: value } as never;
}

function bearer(id = ADMIN_ID, role: AuthUser['role'] = 'platform_admin') {
  return `Bearer ${signToken({ id, role })}`;
}

function suspend(authorization = bearer()) {
  return request(app)
    .post(`/api/admin/events/${EVENT_ID}/suspend`)
    .set('Authorization', authorization);
}

function unsuspend(authorization = bearer()) {
  return request(app)
    .post(`/api/admin/events/${EVENT_ID}/unsuspend`)
    .set('Authorization', authorization);
}

const statements = () => query.mock.calls.map((call) => String(call[0]).trim());
const hasAuditInsert = () => statements().some((sql) => sql.includes('INSERT INTO audit_log'));

beforeEach(() => {
  query.mockReset();
  process.env.JWT_SECRET = 'test-jwt-secret';
});

describe('POST /api/admin/events/:id/suspend', () => {
  it('suspends the event and records an audit entry', async () => {
    query
      .mockResolvedValueOnce(rows([liveEvent]))
      .mockResolvedValueOnce(rows([suspendedEvent]))
      .mockResolvedValueOnce(rows([]));

    const res = await suspend();

    expect(res.status).toBe(200);
    expect(res.body.event).toEqual({
      id: EVENT_ID,
      title: 'Test event',
      status: 'published',
      suspended: true,
      suspended_at: SUSPENDED_AT.toISOString(),
    });
    expect(query.mock.calls[1]?.[1]).toEqual([EVENT_ID, ADMIN_ID]);
    expect(query.mock.calls[2]?.[1]).toEqual([
      ADMIN_ID,
      'event.suspended',
      'event',
      EVENT_ID,
      EVENT_ID,
      'Suspended the event',
    ]);
  });

  it('returns 401 without a token', async () => {
    const res = await request(app).post(`/api/admin/events/${EVENT_ID}/suspend`);

    expect(res.status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });

  it.each(['attendee', 'organizer', 'event_admin'] as const)(
    'returns 403 for the %s role',
    async (role) => {
      const res = await suspend(bearer(ORGANIZER_ID, role));

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(query).not.toHaveBeenCalled();
    },
  );

  it('returns 404 when the event does not exist', async () => {
    query.mockResolvedValueOnce(rows([]));

    const res = await suspend();

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('EVENT_NOT_FOUND');
    expect(hasAuditInsert()).toBe(false);
  });

  it('returns 400 for an invalid event id', async () => {
    const res = await request(app)
      .post('/api/admin/events/not-a-uuid/suspend')
      .set('Authorization', bearer());

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(query).not.toHaveBeenCalled();
  });

  it('returns 409 for an already suspended event and writes no audit entry', async () => {
    query.mockResolvedValueOnce(rows([suspendedEvent]));

    const res = await suspend();

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
    expect(hasAuditInsert()).toBe(false);
  });
});

describe('POST /api/admin/events/:id/unsuspend', () => {
  it('lifts the suspension and records an audit entry', async () => {
    query
      .mockResolvedValueOnce(rows([suspendedEvent]))
      .mockResolvedValueOnce(rows([liveEvent]))
      .mockResolvedValueOnce(rows([]));

    const res = await unsuspend();

    expect(res.status).toBe(200);
    expect(res.body.event).toEqual({
      id: EVENT_ID,
      title: 'Test event',
      status: 'published',
      suspended: false,
      suspended_at: null,
    });
    expect(query.mock.calls[2]?.[1]).toEqual([
      ADMIN_ID,
      'event.unsuspended',
      'event',
      EVENT_ID,
      EVENT_ID,
      'Lifted the suspension of the event',
    ]);
  });

  it('returns 403 for an organizer', async () => {
    const res = await unsuspend(bearer(ORGANIZER_ID, 'organizer'));

    expect(res.status).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });

  it('returns 409 when the event is not suspended', async () => {
    query.mockResolvedValueOnce(rows([liveEvent]));

    const res = await unsuspend();

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
    expect(hasAuditInsert()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

const createdAt = new Date('2026-10-01T09:00:00.000Z');

const userRow = {
  id: USER_ID,
  email: 'aidos@example.kz',
  name: 'Aidos K.',
  role: 'attendee',
  email_verified_at: createdAt,
  suspended_at: null,
  suspended_by: null,
  created_at: createdAt,
};
const suspendedUserRow = {
  ...userRow,
  suspended_at: SUSPENDED_AT,
  suspended_by: ADMIN_ID,
};

describe('GET /api/admin/users', () => {
  it('searches email or name and maps the admin user shape', async () => {
    query.mockResolvedValueOnce(rows([userRow]));

    const res = await request(app)
      .get('/api/admin/users?q=Aidos&limit=10&offset=5')
      .set('Authorization', bearer());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      users: [
        {
          id: USER_ID,
          email: 'aidos@example.kz',
          name: 'Aidos K.',
          role: 'attendee',
          email_verified: true,
          suspended: false,
          suspended_at: null,
          suspended_by: null,
          created_at: createdAt.toISOString(),
        },
      ],
      limit: 10,
      offset: 5,
    });
    expect(query.mock.calls[0]?.[1]).toEqual(['%Aidos%', 10, 5]);
  });

  it('rejects a bad limit before touching the database', async () => {
    const res = await request(app).get('/api/admin/users?limit=0').set('Authorization', bearer());

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(query).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/users/:id/suspend', () => {
  const suspendUser = (id = USER_ID) =>
    request(app).post(`/api/admin/users/${id}/suspend`).set('Authorization', bearer());

  it('suspends the user and records user.suspended', async () => {
    query
      .mockResolvedValueOnce(rows([userRow]))
      .mockResolvedValueOnce(rows([suspendedUserRow]))
      .mockResolvedValueOnce(rows([]));

    const res = await suspendUser();

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({
      id: USER_ID,
      suspended: true,
      suspended_at: SUSPENDED_AT.toISOString(),
      suspended_by: ADMIN_ID,
    });
    expect(query.mock.calls[1]?.[1]).toEqual([USER_ID, ADMIN_ID]);
    expect(query.mock.calls[2]?.[1]).toEqual([
      ADMIN_ID,
      'user.suspended',
      'user',
      USER_ID,
      null,
      'Suspended the user account',
    ]);
  });

  it('refuses to suspend the admin themselves', async () => {
    query.mockResolvedValueOnce(rows([{ ...userRow, id: ADMIN_ID }]));

    const res = await suspendUser(ADMIN_ID);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
    expect(hasAuditInsert()).toBe(false);
  });

  it('refuses to suspend another platform admin', async () => {
    query.mockResolvedValueOnce(rows([{ ...userRow, role: 'platform_admin' }]));

    const res = await suspendUser();

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
    expect(hasAuditInsert()).toBe(false);
  });

  it('returns 409 for an already suspended user', async () => {
    query.mockResolvedValueOnce(rows([suspendedUserRow]));

    const res = await suspendUser();

    expect(res.status).toBe(409);
    expect(hasAuditInsert()).toBe(false);
  });

  it('returns 404 for an unknown user', async () => {
    query.mockResolvedValueOnce(rows([]));

    const res = await suspendUser();

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('USER_NOT_FOUND');
  });
});

describe('POST /api/admin/users/:id/unsuspend', () => {
  const unsuspendUser = (id = USER_ID) =>
    request(app).post(`/api/admin/users/${id}/unsuspend`).set('Authorization', bearer());

  it('lifts the suspension and records user.unsuspended', async () => {
    query
      .mockResolvedValueOnce(rows([suspendedUserRow]))
      .mockResolvedValueOnce(rows([userRow]))
      .mockResolvedValueOnce(rows([]));

    const res = await unsuspendUser();

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ suspended: false, suspended_at: null });
    expect(query.mock.calls[2]?.[1]).toEqual([
      ADMIN_ID,
      'user.unsuspended',
      'user',
      USER_ID,
      null,
      'Lifted the user suspension',
    ]);
  });

  it('returns 409 when the user is not suspended', async () => {
    query.mockResolvedValueOnce(rows([userRow]));

    const res = await unsuspendUser();

    expect(res.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// Event search and reports
// ---------------------------------------------------------------------------

const adminEventRow = {
  id: EVENT_ID,
  title: 'Test event',
  status: 'published',
  suspended_at: null,
  starts_at: createdAt,
  ends_at: createdAt,
  organizer_id: ORGANIZER_ID,
  organizer_name: 'Aigerim S.',
  organizer_email: 'organizer@example.kz',
  open_reports: 2,
};

describe('GET /api/admin/events', () => {
  it('returns every status with organizer and open report count', async () => {
    query.mockResolvedValueOnce(rows([adminEventRow]));

    const res = await request(app)
      .get('/api/admin/events?q=test&status=published')
      .set('Authorization', bearer());

    expect(res.status).toBe(200);
    expect(res.body.events[0]).toMatchObject({
      id: EVENT_ID,
      suspended: false,
      organizer: {
        id: ORGANIZER_ID,
        name: 'Aigerim S.',
        email: 'organizer@example.kz',
      },
      open_reports: 2,
    });
    expect(query.mock.calls[0]?.[1]).toEqual(['%test%', 'published', 20, 0]);
  });

  it('rejects an unknown status', async () => {
    const res = await request(app)
      .get('/api/admin/events?status=deleted')
      .set('Authorization', bearer());

    expect(res.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });
});

const reportRow = {
  id: REPORT_ID,
  event_id: EVENT_ID,
  reported_by: USER_ID,
  reason: 'Spam in the description',
  status: 'open',
  created_at: createdAt,
  reviewed_by: null,
  reviewed_at: null,
  event_title: 'Test event',
  event_status: 'published',
  event_suspended_at: null,
  reporter_name: 'Aidos K.',
  reporter_email: 'aidos@example.kz',
};

describe('POST /api/events/:id/report', () => {
  const report = (body: object, token = bearer(USER_ID, 'attendee')) =>
    request(app).post(`/api/events/${EVENT_ID}/report`).set('Authorization', token).send(body);

  it('records a report from any logged-in user', async () => {
    query
      .mockResolvedValueOnce(rows([{ id: EVENT_ID }]))
      .mockResolvedValueOnce(rows([reportRow]))
      .mockResolvedValueOnce(
        rows([{ title: 'Test event', status: 'published', suspended_at: null }]),
      )
      .mockResolvedValueOnce(rows([{ name: 'Aidos K.', email: 'aidos@example.kz' }]));

    const res = await report({ reason: 'Spam in the description' });

    expect(res.status).toBe(201);
    expect(res.body.report).toMatchObject({
      id: REPORT_ID,
      status: 'open',
      reason: 'Spam in the description',
      event: { id: EVENT_ID, title: 'Test event' },
      reported_by: { id: USER_ID, email: 'aidos@example.kz' },
    });
  });

  it('returns 409 for a duplicate open report', async () => {
    query
      .mockResolvedValueOnce(rows([{ id: EVENT_ID }]))
      .mockRejectedValueOnce(Object.assign(new Error('duplicate'), { code: '23505' }));

    const res = await report({ reason: 'Again' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('returns 404 for an event that is not public', async () => {
    query.mockResolvedValueOnce(rows([]));

    const res = await report({ reason: 'Spam' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('EVENT_NOT_FOUND');
  });

  it.each([
    ['missing reason', {}],
    ['empty reason', { reason: '   ' }],
    ['too long', { reason: 'x'.repeat(1001) }],
  ])('returns 400 for %s', async (_label, body) => {
    const res = await report(body);

    expect(res.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('GET /api/admin/reports', () => {
  it('defaults to open reports and maps the review shape', async () => {
    query.mockResolvedValueOnce(rows([reportRow]));

    const res = await request(app).get('/api/admin/reports').set('Authorization', bearer());

    expect(res.status).toBe(200);
    expect(res.body.reports[0]).toMatchObject({
      id: REPORT_ID,
      status: 'open',
      event: { id: EVENT_ID, suspended: false },
      reported_by: { id: USER_ID },
    });
    expect(query.mock.calls[0]?.[1]).toEqual(['open', 20, 0]);
  });
});

describe('POST /api/admin/reports/:id/resolve', () => {
  const resolve = (body: object) =>
    request(app)
      .post(`/api/admin/reports/${REPORT_ID}/resolve`)
      .set('Authorization', bearer())
      .send(body);

  it('dismisses a report and records event_report.dismissed', async () => {
    query
      .mockResolvedValueOnce(rows([{ id: REPORT_ID, event_id: EVENT_ID, status: 'open' }]))
      .mockResolvedValueOnce(rows([]))
      .mockResolvedValueOnce(rows([]))
      .mockResolvedValueOnce(rows([{ ...reportRow, status: 'dismissed', reviewed_by: ADMIN_ID }]));

    const res = await resolve({ action: 'dismiss' });

    expect(res.status).toBe(200);
    expect(res.body.report.status).toBe('dismissed');
    expect(query.mock.calls[1]?.[0]).toContain('dismissed');
    expect(query.mock.calls[2]?.[1]).toEqual([
      ADMIN_ID,
      'event_report.dismissed',
      'event_report',
      REPORT_ID,
      EVENT_ID,
      'Dismissed the event report',
    ]);
  });

  it('suspends the event through the existing logic and actions every open report', async () => {
    query
      .mockResolvedValueOnce(rows([{ id: REPORT_ID, event_id: EVENT_ID, status: 'open' }]))
      .mockResolvedValueOnce(rows([liveEvent]))
      .mockResolvedValueOnce(rows([suspendedEvent]))
      .mockResolvedValueOnce(rows([]))
      .mockResolvedValueOnce(rows([]))
      .mockResolvedValueOnce(rows([{ ...reportRow, status: 'actioned' }]));

    const res = await resolve({ action: 'suspend' });

    expect(res.status).toBe(200);
    expect(res.body.report.status).toBe('actioned');
    expect(query.mock.calls[3]?.[1]).toEqual([
      ADMIN_ID,
      'event.suspended',
      'event',
      EVENT_ID,
      EVENT_ID,
      'Suspended the event',
    ]);
    expect(query.mock.calls[4]?.[0]).toContain("SET status = 'actioned'");
  });

  it('returns 409 for an already resolved report', async () => {
    query.mockResolvedValueOnce(rows([{ id: REPORT_ID, event_id: EVENT_ID, status: 'dismissed' }]));

    const res = await resolve({ action: 'dismiss' });

    expect(res.status).toBe(409);
    expect(hasAuditInsert()).toBe(false);
  });

  it('rejects an unknown action', async () => {
    const res = await resolve({ action: 'delete' });

    expect(res.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const settingsRow = {
  id: SETTINGS_ID,
  activation_fee: 500000,
  updated_at: createdAt,
  updated_by: null,
};

describe('GET /api/admin/settings', () => {
  it('returns the activation fee in tiyn', async () => {
    query.mockResolvedValueOnce(rows([settingsRow]));

    const res = await request(app).get('/api/admin/settings').set('Authorization', bearer());

    expect(res.status).toBe(200);
    expect(res.body.settings).toEqual({
      activation_fee: 500000,
      currency: 'KZT',
      updated_at: createdAt.toISOString(),
      updated_by: null,
    });
  });
});

describe('PATCH /api/admin/settings', () => {
  it('updates the fee and records platform_settings.updated', async () => {
    query
      .mockResolvedValueOnce(rows([settingsRow]))
      .mockResolvedValueOnce(rows([{ ...settingsRow, activation_fee: 750000 }]))
      .mockResolvedValueOnce(rows([]));

    const res = await request(app)
      .patch('/api/admin/settings')
      .set('Authorization', bearer())
      .send({ activation_fee: 750000 });

    expect(res.status).toBe(200);
    expect(res.body.settings.activation_fee).toBe(750000);
    expect(query.mock.calls[1]?.[1]).toEqual([750000, ADMIN_ID, SETTINGS_ID]);
    expect(query.mock.calls[2]?.[1]).toEqual([
      ADMIN_ID,
      'platform_settings.updated',
      'platform_settings',
      SETTINGS_ID,
      null,
      'Activation fee set to 7500.00 KZT',
    ]);
  });

  it.each([
    ['negative', { activation_fee: -1 }],
    ['not an integer', { activation_fee: 10.5 }],
    ['a string', { activation_fee: '5000' }],
    ['missing', {}],
  ])('returns 400 for %s', async (_label, body) => {
    const res = await request(app)
      .patch('/api/admin/settings')
      .set('Authorization', bearer())
      .send(body);

    expect(res.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Orders and CSV
// ---------------------------------------------------------------------------

const orderRow = {
  id: ORDER_ID,
  status: 'refunded',
  buyer_id: USER_ID,
  buyer_name: 'Buyer, "quoted"',
  buyer_email: 'buyer@example.kz',
  event_id: EVENT_ID,
  event_title: 'Test event',
  subtotal: 500000,
  discount: 0,
  processing_fee: 15000,
  total: 515000,
  created_at: createdAt,
  payment_amount: 515000,
  payment_currency: 'KZT',
  payment_method: 'simulated',
  payment_is_demonstration: true,
  payment_paid_at: createdAt,
  refund_amount: 515000,
  refund_currency: 'KZT',
  refund_is_demonstration: true,
  refund_paid_at: SUSPENDED_AT,
  failed_payment_attempts: 1,
  last_payment_failed_at: SUSPENDED_AT,
};

describe('GET /api/admin/orders', () => {
  it('searches by order id or buyer email and includes refund and failure data', async () => {
    query.mockResolvedValueOnce(rows([orderRow]));

    const res = await request(app)
      .get('/api/admin/orders?q=buyer&status=refunded')
      .set('Authorization', bearer());

    expect(res.status).toBe(200);
    expect(res.body.orders[0]).toMatchObject({
      id: ORDER_ID,
      status: 'refunded',
      buyer: { email: 'buyer@example.kz' },
      event: { id: EVENT_ID },
      refund: { amount: 515000, is_demonstration: true },
      failed_payment_attempts: 1,
    });
    expect(query.mock.calls[0]?.[1]).toEqual(['%buyer%', 'refunded', 20, 0]);
  });

  it('rejects an unknown status', async () => {
    const res = await request(app)
      .get('/api/admin/orders?status=failed')
      .set('Authorization', bearer());

    expect(res.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('CSV exports', () => {
  it('quotes commas, quotes and newlines and doubles embedded quotes', () => {
    expect(
      toCsv([
        ['name', 'note'],
        ['plain', 'a,b'],
        ['quote', 'say "hi"'],
        ['line', 'one\ntwo'],
      ]),
    ).toBe('name,note\nplain,"a,b"\nquote,"say ""hi"""\nline,"one\ntwo"\n');
  });

  it('exports orders with a header and one row per order', async () => {
    query.mockResolvedValueOnce(rows([orderRow]));

    const res = await request(app)
      .get('/api/admin/export/orders.csv')
      .set('Authorization', bearer());

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const lines = (res.text as string).split('\n');
    expect(lines[0]).toBe(
      'order_id,status,buyer_name,buyer_email,event_id,event_title,subtotal_kzt,' +
        'discount_kzt,processing_fee_kzt,total_kzt,created_at,payment_method,' +
        'payment_amount_kzt,refunded_at,refund_amount_kzt,failed_payment_attempts,' +
        'last_payment_failed_at',
    );
    expect(lines[1]).toContain(ORDER_ID);
    expect(lines[1]).toContain('"Buyer, ""quoted"""');
    expect(lines[1]).toContain('5000.00');
    expect(lines).toHaveLength(3); // header, one order, trailing newline
  });

  it('exports refunds with amounts in tenge', async () => {
    query.mockResolvedValueOnce(
      rows([
        {
          id: REPORT_ID,
          order_id: ORDER_ID,
          buyer_name: 'Buyer',
          buyer_email: 'buyer@example.kz',
          event_title: 'Test event',
          amount: 515000,
          currency: 'KZT',
          method: 'simulated',
          is_demonstration: true,
          refunded_at: SUSPENDED_AT,
          refunded_by: ADMIN_ID,
        },
      ]),
    );

    const res = await request(app)
      .get('/api/admin/export/refunds.csv')
      .set('Authorization', bearer());

    expect(res.status).toBe(200);
    expect(res.text as string).toContain('amount_kzt');
    expect(res.text as string).toContain('5150.00');
  });
});

// ---------------------------------------------------------------------------
// Every admin endpoint is platform-admin only
// ---------------------------------------------------------------------------

const ADMIN_ENDPOINTS: [string, string, unknown?][] = [
  ['get', '/api/admin/users'],
  ['post', `/api/admin/users/${USER_ID}/suspend`],
  ['post', `/api/admin/users/${USER_ID}/unsuspend`],
  ['get', '/api/admin/events'],
  ['post', `/api/admin/events/${EVENT_ID}/suspend`],
  ['post', `/api/admin/events/${EVENT_ID}/unsuspend`],
  ['get', '/api/admin/reports'],
  ['post', `/api/admin/reports/${REPORT_ID}/resolve`, { action: 'dismiss' }],
  ['get', '/api/admin/settings'],
  ['patch', '/api/admin/settings', { activation_fee: 500000 }],
  ['get', '/api/admin/orders'],
  ['get', '/api/admin/export/orders.csv'],
  ['get', '/api/admin/export/refunds.csv'],
];

describe('admin endpoint access control', () => {
  it.each(ADMIN_ENDPOINTS)('%s %s is 401 without a token', async (method, path, body) => {
    const call = request(app)[method as 'get'](path);
    const res = await (body === undefined ? call : call.send(body as object));

    expect(res.status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });

  it.each(ADMIN_ENDPOINTS)('%s %s is 403 for a non-admin', async (method, path, body) => {
    const call = request(app)
      [method as 'get'](path)
      .set('Authorization', bearer(ORGANIZER_ID, 'organizer'));
    const res = await (body === undefined ? call : call.send(body as object));

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(query).not.toHaveBeenCalled();
  });
});
