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

const draftEvent = {
  id: EVENT_ID,
  title: 'Test event',
  description: 'Test description',
  venue_name: 'Test venue',
  venue_address: 'Test address',
  starts_at: new Date('2026-11-14T18:00:00.000Z'),
  ends_at: new Date('2026-11-14T21:00:00.000Z'),
  status: 'draft',
  cover_image_url: null,
  organizer_id: ORGANIZER_ID,
  organizer_name: 'Organizer',
  start_time_passed: false,
};

function rows(value: unknown[]) {
  return { rows: value } as never;
}

function changes(rowCount: number) {
  return { rows: [], rowCount } as never;
}

function bearer(userId = ORGANIZER_ID) {
  return `Bearer ${signToken({ id: userId, role: 'organizer' })}`;
}

function publish(userId = ORGANIZER_ID) {
  return request(app).post(`/api/events/${EVENT_ID}/publish`).set('Authorization', bearer(userId));
}

function cancel(userId = ORGANIZER_ID) {
  return request(app).post(`/api/events/${EVENT_ID}/cancel`).set('Authorization', bearer(userId));
}

const statements = () => query.mock.calls.map((call) => String(call[0]).trim());
const hasAuditInsert = () => statements().some((sql) => sql.includes('INSERT INTO audit_log'));

beforeEach(() => {
  query.mockReset();
  process.env.JWT_SECRET = 'test-jwt-secret';
});

describe('POST /api/events/:id/publish', () => {
  it('publishes a draft and records an audit entry', async () => {
    query
      .mockResolvedValueOnce(rows([draftEvent]))
      .mockResolvedValueOnce(rows([{ has_ticket_types: true }]))
      .mockResolvedValueOnce(rows([{ ...draftEvent, status: 'published' }]))
      .mockResolvedValueOnce(rows([]));

    const res = await publish();

    expect(res.status).toBe(200);
    expect(res.body.event).toMatchObject({
      id: EVENT_ID,
      status: 'published',
      organizer: { id: ORGANIZER_ID, name: 'Organizer' },
    });
    expect(query.mock.calls[2]?.[1]).toEqual([EVENT_ID]);
    expect(query.mock.calls[3]?.[1]).toEqual([
      ORGANIZER_ID,
      'event.published',
      'event',
      EVENT_ID,
      EVENT_ID,
      'Published the event',
    ]);
  });

  it('returns 401 without a token', async () => {
    const res = await request(app).post(`/api/events/${EVENT_ID}/publish`);

    expect(res.status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });

  it("returns 403 on somebody else's event", async () => {
    query.mockResolvedValueOnce(rows([draftEvent]));

    const res = await publish(STRANGER_ID);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(hasAuditInsert()).toBe(false);
  });

  it('returns 404 when the event does not exist', async () => {
    query.mockResolvedValueOnce(rows([]));

    const res = await publish();

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('EVENT_NOT_FOUND');
  });

  it('returns 400 for an invalid event id', async () => {
    const res = await request(app)
      .post('/api/events/not-a-uuid/publish')
      .set('Authorization', bearer());

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(query).not.toHaveBeenCalled();
  });

  it('returns 409 for an already published event and writes no audit entry', async () => {
    query.mockResolvedValueOnce(rows([{ ...draftEvent, status: 'published' }]));

    const res = await publish();

    expect(res.status).toBe(409);
    expect(res.body.error).toEqual({
      code: 'CONFLICT',
      message: 'The event is already published',
    });
    expect(hasAuditInsert()).toBe(false);
  });

  it('returns 409 for a cancelled event and writes no audit entry', async () => {
    query.mockResolvedValueOnce(rows([{ ...draftEvent, status: 'cancelled' }]));

    const res = await publish();

    expect(res.status).toBe(409);
    expect(res.body.error).toEqual({
      code: 'CONFLICT',
      message: 'A cancelled event cannot be published',
    });
    expect(hasAuditInsert()).toBe(false);
  });

  it('returns 409 without ticket types and writes no audit entry', async () => {
    query
      .mockResolvedValueOnce(rows([draftEvent]))
      .mockResolvedValueOnce(rows([{ has_ticket_types: false }]));

    const res = await publish();

    expect(res.status).toBe(409);
    expect(res.body.error).toEqual({
      code: 'CONFLICT',
      message: 'Add at least one ticket type before publishing',
    });
    expect(hasAuditInsert()).toBe(false);
  });

  it('returns 409 when the start time has passed and writes no audit entry', async () => {
    query
      .mockResolvedValueOnce(rows([{ ...draftEvent, start_time_passed: true }]))
      .mockResolvedValueOnce(rows([{ has_ticket_types: true }]));

    const res = await publish();

    expect(res.status).toBe(409);
    expect(res.body.error).toEqual({
      code: 'CONFLICT',
      message: 'The event start time has already passed',
    });
    expect(hasAuditInsert()).toBe(false);
  });
});

describe('POST /api/events/:id/cancel', () => {
  it('cancels an event, its valid tickets and pending orders, and records their counts', async () => {
    query
      .mockResolvedValueOnce(rows([{ ...draftEvent, status: 'published' }]))
      .mockResolvedValueOnce(rows([{ ...draftEvent, status: 'cancelled' }]))
      .mockResolvedValueOnce(changes(12))
      .mockResolvedValueOnce(changes(3))
      .mockResolvedValueOnce(rows([]));

    const res = await cancel();

    expect(res.status).toBe(200);
    expect(res.body.event).toMatchObject({
      id: EVENT_ID,
      status: 'cancelled',
      organizer: { id: ORGANIZER_ID, name: 'Organizer' },
    });
    expect(statements()[2]).toContain("UPDATE tickets SET status = 'cancelled'");
    expect(statements()[2]).toContain("status = 'valid'");
    expect(statements()[3]).toContain("UPDATE orders SET status = 'cancelled'");
    expect(statements()[3]).toContain("status = 'pending'");
    expect(query.mock.calls[4]?.[1]).toEqual([
      ORGANIZER_ID,
      'event.cancelled',
      'event',
      EVENT_ID,
      EVENT_ID,
      'Cancelled the event: 12 tickets and 3 pending orders cancelled',
    ]);
  });

  it("returns 403 on somebody else's event", async () => {
    query.mockResolvedValueOnce(rows([draftEvent]));

    const res = await cancel(STRANGER_ID);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(hasAuditInsert()).toBe(false);
  });

  it('returns 409 for an already cancelled event and writes no audit entry', async () => {
    query.mockResolvedValueOnce(rows([{ ...draftEvent, status: 'cancelled' }]));

    const res = await cancel();

    expect(res.status).toBe(409);
    expect(res.body.error).toEqual({
      code: 'CONFLICT',
      message: 'The event is already cancelled',
    });
    expect(hasAuditInsert()).toBe(false);
  });
});
