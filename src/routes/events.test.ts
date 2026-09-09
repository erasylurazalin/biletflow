/**
 * Tests for the reference endpoint. Copy this file's shape for your own routes.
 *
 * These are not database tests. We replace src/db/pool with a fake whose query()
 * returns whatever the test says, which means:
 *   - `npm test` works without Docker running
 *   - a failure points at the route, not at the state of your local database
 * The cost is that the SQL itself is never executed, so a typo inside the query string
 * only shows up when you run the server. Check your endpoint by hand with curl too.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

// Must be declared before importing anything that imports the pool. Vitest hoists
// vi.mock() calls to the top of the file for exactly this reason.
vi.mock('../db/pool', () => ({ pool: { query: vi.fn() } }));

import { pool } from '../db/pool';
import { createApp } from '../app';

const query = vi.mocked(pool.query);
const app = createApp();

const eventRow = {
  id: '33333333-3333-4333-8333-333333333333',
  title: 'Astana Tech Meetup',
  short_description: 'Monthly meetup for developers.',
  description: 'Monthly meetup for developers.',
  venue_name: 'Nazarbayev University',
  venue_address: 'Kabanbay Batyr 53, Astana',
  starts_at: new Date('2026-11-14T18:00:00Z'),
  ends_at: new Date('2026-11-14T21:00:00Z'),
  status: 'published',
  cover_image_url: null,
  organizer_id: '11111111-1111-4111-8111-111111111111',
  organizer_name: 'Aigerim S.',
};

// Only the fields the route actually reads. rowCount and friends are unused here.
function rows(value: unknown[]) {
  return { rows: value } as never;
}

beforeEach(() => {
  query.mockReset();
});

describe('GET /api/events', () => {
  it('returns published events in the documented shape', async () => {
    query.mockResolvedValueOnce(rows([eventRow]));

    const res = await request(app).get('/api/events');

    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0]).toMatchObject({
      id: eventRow.id,
      title: 'Astana Tech Meetup',
      status: 'published',
      organizer: { id: eventRow.organizer_id, name: 'Aigerim S.' },
    });
    // Timestamps go out as ISO 8601 UTC strings, not as Date objects.
    expect(res.body.events[0].starts_at).toBe('2026-11-14T18:00:00.000Z');
    // The list must not carry ticket types (docs/api.md).
    expect(res.body.events[0].ticket_types).toBeUndefined();
  });

  it('passes limit and offset through to the query', async () => {
    query.mockResolvedValueOnce(rows([]));

    const res = await request(app).get('/api/events?limit=5&offset=10');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ limit: 5, offset: 10 });
    expect(query.mock.calls[0]?.[1]).toEqual([5, 10, null]);
  });

  it('rejects a limit that is not a number, without touching the database', async () => {
    const res = await request(app).get('/api/events?limit=abc');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(query).not.toHaveBeenCalled();
  });
});

describe('GET /api/events/:id', () => {
  it('returns the event with its ticket types', async () => {
    query.mockResolvedValueOnce(rows([eventRow])).mockResolvedValueOnce(
      rows([
        {
          id: '55555555-5555-4555-8555-555555555555',
          name: 'Early Bird',
          price: 500000,
          currency: 'KZT',
          quantity_total: 100,
          quantity_available: 57,
          sales_start_at: null,
          sales_end_at: null,
          is_hidden: false,
        },
      ]),
    );

    const res = await request(app).get(`/api/events/${eventRow.id}`);

    expect(res.status).toBe(200);
    expect(res.body.event.description).toBe('Monthly meetup for developers.');
    expect(res.body.event.ticket_types[0]).toMatchObject({
      name: 'Early Bird',
      price: 500000,
      quantity_available: 57,
    });
  });

  it('returns 404 when the event does not exist or is not published', async () => {
    query.mockResolvedValueOnce(rows([]));

    const res = await request(app).get('/api/events/99999999-9999-4999-8999-999999999999');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: { code: 'EVENT_NOT_FOUND', message: 'Event not found' },
    });
  });

  it('returns 400 when the id is not a UUID', async () => {
    const res = await request(app).get('/api/events/banana');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(query).not.toHaveBeenCalled();
  });
});

describe('unknown routes', () => {
  it('answers 404 in the same error shape', async () => {
    const res = await request(app).get('/api/nope');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
