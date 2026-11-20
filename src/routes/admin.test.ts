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

const query = vi.mocked(pool.query);
const app = createApp();

const ADMIN_ID = '99999999-9999-4999-8999-999999999999';
const ORGANIZER_ID = '11111111-1111-4111-8111-111111111111';
const EVENT_ID = '33333333-3333-4333-8333-333333333333';

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
