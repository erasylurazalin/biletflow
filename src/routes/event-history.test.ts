/**
 * Tests for the event timeline and duplicate endpoints. Same approach as
 * events.test.ts: the pool is faked, so validation and authorization run for real but
 * the SQL does not. The real database flow is in event-history.db.test.ts.
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
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const EVENT_ID = '33333333-3333-4333-8333-333333333333';
const ACTOR_ID = '44444444-4444-4444-8444-444444444444';

const accessOwner = { organizer_id: ORGANIZER_ID, is_staff: false };
const accessStaff = { organizer_id: OTHER_ID, is_staff: true };

const entryRow = {
  id: '55555555-5555-4555-8555-555555555555',
  created_at: new Date('2026-10-11T09:00:00Z'),
  action: 'event.published',
  entity_type: 'event',
  entity_id: EVENT_ID,
  description: 'Published the event',
  actor_id: ACTOR_ID,
  actor_name: 'Aigerim S.',
};

const sourceRow = {
  id: EVENT_ID,
  organizer_id: ORGANIZER_ID,
  organizer_name: 'Aigerim S.',
  title: 'Past event',
  description: 'A past event.',
  venue_name: 'Old venue',
  venue_address: 'Old address',
  cover_image_url: null,
  refund_policy: 'Full refunds.',
  starts_at: new Date('2026-01-03T18:00:00Z'),
  ends_at: new Date('2026-01-03T20:00:00Z'),
  weeks_forward: 2,
};

const createdRow = {
  ...sourceRow,
  starts_at: new Date('2026-01-17T18:00:00Z'),
  ends_at: new Date('2026-01-17T20:00:00Z'),
  weeks_forward: 0,
};

const typeRow = {
  id: '66666666-6666-4666-8666-666666666666',
  name: 'Early Bird',
  price: 500000,
  currency: 'KZT',
  quantity_total: 100,
  sales_start_at: new Date('2025-12-01T09:00:00Z'),
  sales_end_at: new Date('2026-01-01T09:00:00Z'),
  is_hidden: false,
};

function rows(value: unknown[]) {
  return { rows: value } as never;
}

function bearer(
  userId = ORGANIZER_ID,
  role: 'organizer' | 'event_admin' | 'platform_admin' = 'organizer',
) {
  return `Bearer ${signToken({ id: userId, role })}`;
}

beforeEach(() => {
  query.mockReset();
  process.env.JWT_SECRET = 'test-jwt-secret';
});

describe('GET /api/events/:id/timeline', () => {
  it("returns the organizer's entries newest first in the documented shape", async () => {
    query
      .mockResolvedValueOnce(rows([accessOwner]))
      .mockResolvedValueOnce(rows([entryRow]))
      .mockResolvedValueOnce(rows([{ action: 'event.published' }]));

    const res = await request(app)
      .get(`/api/events/${EVENT_ID}/timeline`)
      .set('Authorization', bearer());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      entries: [
        {
          id: entryRow.id,
          created_at: '2026-10-11T09:00:00.000Z',
          action: 'event.published',
          entity_type: 'event',
          entity_id: EVENT_ID,
          description: 'Published the event',
          actor: { id: ACTOR_ID, name: 'Aigerim S.' },
        },
      ],
      actions: ['event.published'],
      limit: 20,
      offset: 0,
    });
  });

  it('lets event staff read the timeline', async () => {
    query
      .mockResolvedValueOnce(rows([accessStaff]))
      .mockResolvedValueOnce(rows([]))
      .mockResolvedValueOnce(rows([]));

    const res = await request(app)
      .get(`/api/events/${EVENT_ID}/timeline`)
      .set('Authorization', bearer(OTHER_ID, 'event_admin'));

    expect(res.status).toBe(200);
    expect(res.body.entries).toEqual([]);
  });

  it('lets a platform admin read the timeline', async () => {
    query
      .mockResolvedValueOnce(rows([{ organizer_id: OTHER_ID, is_staff: false }]))
      .mockResolvedValueOnce(rows([]))
      .mockResolvedValueOnce(rows([]));

    const res = await request(app)
      .get(`/api/events/${EVENT_ID}/timeline`)
      .set('Authorization', bearer(ORGANIZER_ID, 'platform_admin'));

    expect(res.status).toBe(200);
  });

  it('returns 404 for another organizer', async () => {
    query.mockResolvedValueOnce(rows([{ organizer_id: OTHER_ID, is_staff: false }]));

    const res = await request(app)
      .get(`/api/events/${EVENT_ID}/timeline`)
      .set('Authorization', bearer());

    expect(res.status).toBe(404);
    expect(res.body.error).toEqual({ code: 'EVENT_NOT_FOUND', message: 'Event not found' });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('returns 404 for an unknown event', async () => {
    query.mockResolvedValueOnce(rows([]));

    const res = await request(app)
      .get(`/api/events/${EVENT_ID}/timeline`)
      .set('Authorization', bearer());

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('EVENT_NOT_FOUND');
  });

  it('returns 401 without a token, without touching the database', async () => {
    const res = await request(app).get(`/api/events/${EVENT_ID}/timeline`);

    expect(res.status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects an action that is not in AUDIT_ACTIONS', async () => {
    const res = await request(app)
      .get(`/api/events/${EVENT_ID}/timeline?action=event.exploded`)
      .set('Authorization', bearer());

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects an impossible date', async () => {
    const res = await request(app)
      .get(`/api/events/${EVENT_ID}/timeline?from=2026-02-31`)
      .set('Authorization', bearer());

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects a range that runs backwards', async () => {
    const res = await request(app)
      .get(`/api/events/${EVENT_ID}/timeline?from=2026-02-10&to=2026-02-01`)
      .set('Authorization', bearer());

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects a bad limit and a non-uuid id', async () => {
    const limit = await request(app)
      .get(`/api/events/${EVENT_ID}/timeline?limit=500`)
      .set('Authorization', bearer());
    const id = await request(app).get('/api/events/banana/timeline').set('Authorization', bearer());

    expect(limit.status).toBe(400);
    expect(id.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it('passes the inclusive local day range, action and paging to the query', async () => {
    query
      .mockResolvedValueOnce(rows([accessOwner]))
      .mockResolvedValueOnce(rows([]))
      .mockResolvedValueOnce(rows([]));

    await request(app)
      .get(
        `/api/events/${EVENT_ID}/timeline?from=2026-01-01&to=2026-01-02&action=event.cancelled&limit=5&offset=2`,
      )
      .set('Authorization', bearer());

    const params = (query.mock.calls[1]?.[1] ?? []) as unknown[];
    // Midnight Asia/Almaty on 1 January to midnight on 3 January, so 2 January is
    // included, plus the action, limit and offset.
    expect(params[1]).toEqual(new Date('2025-12-31T19:00:00Z'));
    expect(params[2]).toEqual(new Date('2026-01-02T19:00:00Z'));
    expect(params.slice(3)).toEqual(['event.cancelled', 5, 2]);
  });
});

describe('POST /api/events/:id/duplicate', () => {
  it('copies the event and ticket types into a fresh draft', async () => {
    query
      .mockResolvedValueOnce(rows([sourceRow]))
      .mockResolvedValueOnce(rows([createdRow]))
      .mockResolvedValueOnce(rows([typeRow]))
      .mockResolvedValueOnce(rows([]))
      .mockResolvedValueOnce(rows([]));

    const res = await request(app)
      .post(`/api/events/${EVENT_ID}/duplicate`)
      .set('Authorization', bearer());

    expect(res.status).toBe(201);
    expect(res.body.event).toMatchObject({
      id: EVENT_ID,
      title: 'Past event',
      status: 'draft',
      organizer: { id: ORGANIZER_ID, name: 'Aigerim S.' },
      paid_sales_active: false,
      ticket_types: [{ name: 'Early Bird', price: 500000, quantity_available: 100 }],
    });
    expect(res.body.event.starts_at).toBe('2026-01-17T18:00:00.000Z');
    expect(query.mock.calls[2]?.[1]).toEqual([EVENT_ID, 2, EVENT_ID]);
  });

  it('returns 404 for another organizer and for an unknown event', async () => {
    query.mockResolvedValueOnce(rows([{ ...sourceRow, organizer_id: OTHER_ID }]));
    const other = await request(app)
      .post(`/api/events/${EVENT_ID}/duplicate`)
      .set('Authorization', bearer());
    expect(other.status).toBe(404);
    expect(other.body.error.code).toBe('EVENT_NOT_FOUND');

    query.mockReset();
    query.mockResolvedValueOnce(rows([]));
    const unknown = await request(app)
      .post(`/api/events/${EVENT_ID}/duplicate`)
      .set('Authorization', bearer());
    expect(unknown.status).toBe(404);
  });

  it('returns 401 without a token and 400 for a non-uuid id', async () => {
    const unauthorized = await request(app).post(`/api/events/${EVENT_ID}/duplicate`);
    expect(unauthorized.status).toBe(401);
    expect(query).not.toHaveBeenCalled();

    const badId = await request(app)
      .post('/api/events/banana/duplicate')
      .set('Authorization', bearer());
    expect(badId.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });
});
