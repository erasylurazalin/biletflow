/**
 * Tests for the organizer write endpoints: POST /api/events and PATCH /api/events/:id.
 * Same approach as events.test.ts: the pool is faked, so the SQL itself never runs.
 * Check both endpoints by hand as well, a typo inside a query string only shows up
 * against a real database.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';

vi.mock('../db/pool', () => ({ pool: { query: vi.fn() } }));

import { pool } from '../db/pool';
import { createApp } from '../app';

// requireAuth reads JWT_SECRET on every request, so tests sign tokens with the same one.
const secret = process.env.JWT_SECRET ?? 'test-secret';
process.env.JWT_SECRET = secret;

const query = vi.mocked(pool.query);
const app = createApp();

const ownerId = '11111111-1111-4111-8111-111111111111';
const otherOrganizerId = '22222222-2222-4222-8222-222222222222';
const attendeeId = '44444444-4444-4444-8444-444444444444';
const eventId = '33333333-3333-4333-8333-333333333333';

function tokenFor(id: string, role: string) {
  return jwt.sign({ id, role }, secret);
}

const organizerToken = tokenFor(ownerId, 'organizer');

const validBody = {
  title: 'Astana Tech Meetup',
  description: 'Monthly meetup for developers.',
  venue_name: 'Nazarbayev University',
  venue_address: 'Kabanbay Batyr 53, Astana',
  starts_at: '2026-11-14T18:00:00Z',
  ends_at: '2026-11-14T21:00:00Z',
};

// What INSERT/UPDATE ... RETURNING gives back, joined with the organizer's name.
const eventRow = {
  id: eventId,
  title: 'Astana Tech Meetup',
  description: 'Monthly meetup for developers.',
  venue_name: 'Nazarbayev University',
  venue_address: 'Kabanbay Batyr 53, Astana',
  starts_at: new Date('2026-11-14T18:00:00Z'),
  ends_at: new Date('2026-11-14T21:00:00Z'),
  status: 'draft',
  cover_image_url: null,
  organizer_id: ownerId,
  organizer_name: 'Aigerim S.',
};

// What the PATCH ownership lookup returns: the owner plus the stored dates.
const ownerRow = {
  organizer_id: ownerId,
  organizer_name: 'Aigerim S.',
  starts_at: new Date('2026-11-14T18:00:00Z'),
  ends_at: new Date('2026-11-14T21:00:00Z'),
};

function rows(value: unknown[]) {
  return { rows: value } as never;
}

beforeEach(() => {
  query.mockReset();
});

describe('POST /api/events', () => {
  it('creates a draft event for an organizer and returns 201', async () => {
    query.mockResolvedValueOnce(rows([eventRow]));

    const res = await request(app)
      .post('/api/events')
      .set('Authorization', `Bearer ${organizerToken}`)
      .send(validBody);

    expect(res.status).toBe(201);
    expect(res.body.event).toMatchObject({
      id: eventId,
      title: 'Astana Tech Meetup',
      status: 'draft',
      organizer: { id: ownerId, name: 'Aigerim S.' },
    });
    expect(res.body.event.starts_at).toBe('2026-11-14T18:00:00.000Z');
    // The organizer comes from the token, never from the request body.
    expect(query.mock.calls[0]?.[1]).toEqual([
      'Astana Tech Meetup',
      'Monthly meetup for developers.',
      'Nazarbayev University',
      'Kabanbay Batyr 53, Astana',
      new Date('2026-11-14T18:00:00Z'),
      new Date('2026-11-14T21:00:00Z'),
      null,
      ownerId,
    ]);
  });

  it('returns 401 without a token', async () => {
    const res = await request(app).post('/api/events').send(validBody);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(query).not.toHaveBeenCalled();
  });

  it('returns 403 when the user is not an organizer', async () => {
    const res = await request(app)
      .post('/api/events')
      .set('Authorization', `Bearer ${tokenFor(attendeeId, 'attendee')}`)
      .send(validBody);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects an empty title, without touching the database', async () => {
    const res = await request(app)
      .post('/api/events')
      .set('Authorization', `Bearer ${organizerToken}`)
      .send({ ...validBody, title: '' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toContain('title');
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects a missing required field', async () => {
    const withoutVenue: Partial<typeof validBody> = { ...validBody };
    delete withoutVenue.venue_name;

    const res = await request(app)
      .post('/api/events')
      .set('Authorization', `Bearer ${organizerToken}`)
      .send(withoutVenue);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toContain('venue_name');
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects a date that is not a date', async () => {
    const res = await request(app)
      .post('/api/events')
      .set('Authorization', `Bearer ${organizerToken}`)
      .send({ ...validBody, starts_at: 'tomorrow-ish' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects an event that ends before it starts', async () => {
    const res = await request(app)
      .post('/api/events')
      .set('Authorization', `Bearer ${organizerToken}`)
      .send({ ...validBody, ends_at: '2026-11-14T10:00:00Z' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toContain('ends_at');
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects a cover image that is not a URL', async () => {
    const res = await request(app)
      .post('/api/events')
      .set('Authorization', `Bearer ${organizerToken}`)
      .send({ ...validBody, cover_image_url: 'not-a-url' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(query).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/events/:id', () => {
  it("updates the organizer's own event", async () => {
    query
      .mockResolvedValueOnce(rows([ownerRow]))
      .mockResolvedValueOnce(rows([{ ...eventRow, title: 'New title' }]));

    const res = await request(app)
      .patch(`/api/events/${eventId}`)
      .set('Authorization', `Bearer ${organizerToken}`)
      .send({ title: 'New title' });

    expect(res.status).toBe(200);
    expect(res.body.event).toMatchObject({
      id: eventId,
      title: 'New title',
      organizer: { id: ownerId, name: 'Aigerim S.' },
    });
    // First call looks up the owner, second one is the UPDATE with only the sent field.
    expect(query.mock.calls[0]?.[1]).toEqual([eventId]);
    expect(query.mock.calls[1]?.[1]).toEqual(['New title', eventId]);
  });

  it('returns 401 without a token', async () => {
    const res = await request(app).patch(`/api/events/${eventId}`).send({ title: 'x' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(query).not.toHaveBeenCalled();
  });

  it('returns 403 when the event belongs to another organizer', async () => {
    query.mockResolvedValueOnce(rows([ownerRow]));

    const res = await request(app)
      .patch(`/api/events/${eventId}`)
      .set('Authorization', `Bearer ${tokenFor(otherOrganizerId, 'organizer')}`)
      .send({ title: 'Hijacked' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    // Only the ownership lookup ran, the UPDATE never happened.
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('returns 404 when the event does not exist', async () => {
    query.mockResolvedValueOnce(rows([]));

    const res = await request(app)
      .patch(`/api/events/${eventId}`)
      .set('Authorization', `Bearer ${organizerToken}`)
      .send({ title: 'New title' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('EVENT_NOT_FOUND');
  });

  it('returns 400 when the id is not a UUID', async () => {
    const res = await request(app)
      .patch('/api/events/banana')
      .set('Authorization', `Bearer ${organizerToken}`)
      .send({ title: 'New title' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects an empty body', async () => {
    const res = await request(app)
      .patch(`/api/events/${eventId}`)
      .set('Authorization', `Bearer ${organizerToken}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects an invalid field value', async () => {
    const res = await request(app)
      .patch(`/api/events/${eventId}`)
      .set('Authorization', `Bearer ${organizerToken}`)
      .send({ title: '' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toContain('title');
    expect(query).not.toHaveBeenCalled();
  });

  it('returns 400, not 500, when only ends_at is sent and it is before the stored start', async () => {
    query.mockResolvedValueOnce(rows([ownerRow]));

    const res = await request(app)
      .patch(`/api/events/${eventId}`)
      .set('Authorization', `Bearer ${organizerToken}`)
      .send({ ends_at: '2026-11-14T10:00:00Z' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toContain('ends_at');
    // Only the ownership lookup ran, so Postgres never saw the bad pair.
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('returns 400 when only starts_at is sent and it is after the stored end', async () => {
    query.mockResolvedValueOnce(rows([ownerRow]));

    const res = await request(app)
      .patch(`/api/events/${eventId}`)
      .set('Authorization', `Bearer ${organizerToken}`)
      .send({ starts_at: '2026-11-15T00:00:00Z' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('accepts new dates that only make sense as a pair', async () => {
    query.mockResolvedValueOnce(rows([ownerRow])).mockResolvedValueOnce(
      rows([
        {
          ...eventRow,
          starts_at: new Date('2026-12-01T10:00:00Z'),
          ends_at: new Date('2026-12-01T12:00:00Z'),
        },
      ]),
    );

    // Each date alone would clash with the stored one, but together they are valid.
    const res = await request(app)
      .patch(`/api/events/${eventId}`)
      .set('Authorization', `Bearer ${organizerToken}`)
      .send({ starts_at: '2026-12-01T10:00:00Z', ends_at: '2026-12-01T12:00:00Z' });

    expect(res.status).toBe(200);
    expect(query).toHaveBeenCalledTimes(2);
  });
});
