/**
 * Tests for the staff assignment endpoints. Same approach as ticket-types.test.ts: the
 * pool is faked, so the owner check and validation run for real but the SQL does not.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../db/pool', () => ({ pool: { query: vi.fn() } }));

import { pool } from '../db/pool';
import { createApp } from '../app';
import { signToken } from '../middleware/auth';

const query = vi.mocked(pool.query);
const app = createApp();

const ORGANIZER_ID = '11111111-1111-4111-8111-111111111111';
const STRANGER_ID = '22222222-2222-4222-8222-222222222222';
const EVENT_ID = '33333333-3333-4333-8333-333333333333';
const STAFF_ID = '44444444-4444-4444-8444-444444444444';

const ASSIGNED_AT = '2026-10-01T09:00:00.000Z';
const staffUser = { id: STAFF_ID, email: 'door@biletflow.kz', name: 'Dana' };
const staffMember = { ...staffUser, assigned_at: ASSIGNED_AT };

function rows(value: unknown[]) {
  return { rows: value } as never;
}

function bearer(userId: string, role: 'organizer' | 'attendee' = 'organizer') {
  return `Bearer ${signToken({ id: userId, role })}`;
}

// What assertOwnsEvent() reads.
const ownedByOrganizer = rows([{ organizer_id: ORGANIZER_ID }]);

beforeEach(() => {
  query.mockReset();
  process.env.JWT_SECRET = 'test-jwt-secret';
});

describe('POST /api/events/:id/staff', () => {
  it('assigns a registered user to my event by email', async () => {
    query
      .mockResolvedValueOnce(ownedByOrganizer)
      .mockResolvedValueOnce(rows([staffUser]))
      .mockResolvedValueOnce(rows([{ assigned_at: new Date(ASSIGNED_AT) }]));

    const res = await request(app)
      .post(`/api/events/${EVENT_ID}/staff`)
      .set('Authorization', bearer(ORGANIZER_ID))
      .send({ email: '  Door@BiletFlow.kz ' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ staff_member: staffMember });
    // Looked up lower-cased, and the assignment records who made it.
    expect(query.mock.calls[1]?.[1]).toEqual(['door@biletflow.kz']);
    expect(query.mock.calls[2]?.[1]).toEqual([EVENT_ID, STAFF_ID, ORGANIZER_ID]);
  });

  it('answers 200 with the existing assignment when the user is already assigned', async () => {
    query
      .mockResolvedValueOnce(ownedByOrganizer)
      .mockResolvedValueOnce(rows([staffUser]))
      // ON CONFLICT DO NOTHING: no row back.
      .mockResolvedValueOnce(rows([]))
      .mockResolvedValueOnce(rows([{ assigned_at: new Date(ASSIGNED_AT) }]));

    const res = await request(app)
      .post(`/api/events/${EVENT_ID}/staff`)
      .set('Authorization', bearer(ORGANIZER_ID))
      .send({ email: 'door@biletflow.kz' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ staff_member: staffMember });
    expect(query.mock.calls[3]?.[1]).toEqual([EVENT_ID, STAFF_ID]);
  });

  it("returns 403 on somebody else's event and looks nobody up", async () => {
    query.mockResolvedValueOnce(ownedByOrganizer);

    const res = await request(app)
      .post(`/api/events/${EVENT_ID}/staff`)
      .set('Authorization', bearer(STRANGER_ID))
      .send({ email: 'door@biletflow.kz' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('returns 404 USER_NOT_FOUND for an email nobody registered with', async () => {
    query.mockResolvedValueOnce(ownedByOrganizer).mockResolvedValueOnce(rows([]));

    const res = await request(app)
      .post(`/api/events/${EVENT_ID}/staff`)
      .set('Authorization', bearer(ORGANIZER_ID))
      .send({ email: 'nobody@biletflow.kz' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('USER_NOT_FOUND');
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('returns 404 EVENT_NOT_FOUND when the event does not exist', async () => {
    query.mockResolvedValueOnce(rows([]));

    const res = await request(app)
      .post(`/api/events/${EVENT_ID}/staff`)
      .set('Authorization', bearer(ORGANIZER_ID))
      .send({ email: 'door@biletflow.kz' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('EVENT_NOT_FOUND');
  });

  it('returns 401 without a token', async () => {
    const res = await request(app)
      .post(`/api/events/${EVENT_ID}/staff`)
      .send({ email: 'door@biletflow.kz' });

    expect(res.status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing email', {}],
    ['something that is not an email', { email: 'door' }],
  ])('returns 400 for %s, without touching the database', async (_label, invalid) => {
    const res = await request(app)
      .post(`/api/events/${EVENT_ID}/staff`)
      .set('Authorization', bearer(ORGANIZER_ID))
      .send(invalid);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(query).not.toHaveBeenCalled();
  });

  it('returns 400 when the event id is not a UUID', async () => {
    const res = await request(app)
      .post('/api/events/banana/staff')
      .set('Authorization', bearer(ORGANIZER_ID))
      .send({ email: 'door@biletflow.kz' });

    expect(res.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('GET /api/events/:id/staff', () => {
  it('lists the staff of my event in the list envelope', async () => {
    query
      .mockResolvedValueOnce(ownedByOrganizer)
      .mockResolvedValueOnce(rows([{ ...staffUser, assigned_at: new Date(ASSIGNED_AT) }]));

    const res = await request(app)
      .get(`/api/events/${EVENT_ID}/staff?limit=5`)
      .set('Authorization', bearer(ORGANIZER_ID));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ staff: [staffMember], limit: 5, offset: 0 });
    expect(query.mock.calls[1]?.[1]).toEqual([EVENT_ID, 5, 0]);
  });

  it("returns 403 on somebody else's event", async () => {
    query.mockResolvedValueOnce(ownedByOrganizer);

    const res = await request(app)
      .get(`/api/events/${EVENT_ID}/staff`)
      .set('Authorization', bearer(STRANGER_ID));

    expect(res.status).toBe(403);
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe('DELETE /api/events/:id/staff/:userId', () => {
  it('removes a staff member from my event', async () => {
    query.mockResolvedValueOnce(ownedByOrganizer).mockResolvedValueOnce({ rowCount: 1 } as never);

    const res = await request(app)
      .delete(`/api/events/${EVENT_ID}/staff/${STAFF_ID}`)
      .set('Authorization', bearer(ORGANIZER_ID));

    expect(res.status).toBe(204);
    expect(query.mock.calls[1]?.[1]).toEqual([EVENT_ID, STAFF_ID]);
  });

  it("returns 403 on somebody else's event and deletes nothing", async () => {
    query.mockResolvedValueOnce(ownedByOrganizer);

    const res = await request(app)
      .delete(`/api/events/${EVENT_ID}/staff/${STAFF_ID}`)
      .set('Authorization', bearer(STRANGER_ID));

    expect(res.status).toBe(403);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('returns 404 when the user is not on the staff', async () => {
    query.mockResolvedValueOnce(ownedByOrganizer).mockResolvedValueOnce({ rowCount: 0 } as never);

    const res = await request(app)
      .delete(`/api/events/${EVENT_ID}/staff/${STAFF_ID}`)
      .set('Authorization', bearer(ORGANIZER_ID));

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('returns 400 when the user id is not a UUID', async () => {
    const res = await request(app)
      .delete(`/api/events/${EVENT_ID}/staff/banana`)
      .set('Authorization', bearer(ORGANIZER_ID));

    expect(res.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('GET /api/staff/events', () => {
  it('lists the events the caller is assigned to', async () => {
    query.mockResolvedValueOnce(
      rows([
        {
          id: EVENT_ID,
          title: 'Astana Tech Meetup',
          short_description: 'Talks and pizza',
          venue_name: 'Nazarbayev University',
          venue_address: 'Kabanbay Batyr 53, Astana',
          starts_at: new Date('2026-11-14T18:00:00Z'),
          ends_at: new Date('2026-11-14T21:00:00Z'),
          status: 'published',
          cover_image_url: null,
          organizer_id: ORGANIZER_ID,
          organizer_name: 'Aigerim S.',
        },
      ]),
    );

    // No special role needed: an attendee who was assigned sees the event.
    const res = await request(app)
      .get('/api/staff/events')
      .set('Authorization', bearer(STAFF_ID, 'attendee'));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      events: [
        {
          id: EVENT_ID,
          title: 'Astana Tech Meetup',
          description: 'Talks and pizza',
          venue_name: 'Nazarbayev University',
          venue_address: 'Kabanbay Batyr 53, Astana',
          starts_at: '2026-11-14T18:00:00.000Z',
          ends_at: '2026-11-14T21:00:00.000Z',
          status: 'published',
          cover_image_url: null,
          organizer: { id: ORGANIZER_ID, name: 'Aigerim S.' },
        },
      ],
      limit: 20,
      offset: 0,
    });
    // Scoped to the caller from the token, never to anything the client sends.
    expect(query.mock.calls[0]?.[1]).toEqual([STAFF_ID, 20, 0]);
  });

  it('returns an empty list for somebody assigned to nothing', async () => {
    query.mockResolvedValueOnce(rows([]));

    const res = await request(app)
      .get('/api/staff/events')
      .set('Authorization', bearer(STRANGER_ID, 'attendee'));

    expect(res.status).toBe(200);
    expect(res.body.events).toEqual([]);
  });

  it('returns 401 without a token', async () => {
    const res = await request(app).get('/api/staff/events');

    expect(res.status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });
});
