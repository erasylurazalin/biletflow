import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../db/pool', () => ({ pool: { query: vi.fn() } }));

import { pool } from '../db/pool';
import { createApp } from '../app';

const query = vi.mocked(pool.query);
const app = createApp();

const eventRow = {
  id: '33333333-3333-4333-8333-333333333333',
  title: 'Astana Tech Meetup',
  description: 'Monthly meetup for developers.',
  venue_name: 'Nazarbayev University',
  venue_address: 'Kabanbay Batyr 53, Astana',
  starts_at: new Date('2026-11-14T18:00:00Z'),
  ends_at: new Date('2026-11-14T21:00:00Z'),
};

function rows(value: unknown[]) {
  return { rows: value } as never;
}

beforeEach(() => {
  query.mockReset();
});

describe('GET /api/events/:id/calendar.ics', () => {
  it('returns a calendar file with the documented headers and event fields', async () => {
    query.mockResolvedValueOnce(rows([eventRow]));

    const res = await request(app).get(`/api/events/${eventRow.id}/calendar.ics`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/calendar; charset=utf-8');
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="astana-tech-meetup.ics"',
    );

    const body = res.text;
    expect(body).toContain('BEGIN:VCALENDAR\r\n');
    expect(body).toContain(`UID:${eventRow.id}@biletflow\r\n`);
    expect(body).toContain('DTSTART:20261114T180000Z\r\n');
    expect(body).toContain('DTEND:20261114T210000Z\r\n');
    expect(body).toContain('SUMMARY:Astana Tech Meetup\r\n');
    expect(body).toContain('END:VCALENDAR\r\n');
    // Every line is a physical line of the calendar, not a bare LF.
    expect(body.replace(/\r\n/g, '')).not.toContain('\n');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('filters on published and unsuspended events in the query', async () => {
    query.mockResolvedValueOnce(rows([]));

    await request(app).get(`/api/events/${eventRow.id}/calendar.ics`);

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("e.status = 'published'");
    expect(sql).toContain('e.suspended_at IS NULL');
    expect(query.mock.calls[0]?.[1]).toEqual([eventRow.id]);
  });

  it.each(['draft', 'cancelled', 'suspended', 'unknown'])(
    'returns 404 EVENT_NOT_FOUND for a %s event',
    async () => {
      query.mockResolvedValueOnce(rows([]));

      const res = await request(app).get(`/api/events/${eventRow.id}/calendar.ics`);

      expect(res.status).toBe(404);
      expect(res.body).toEqual({
        error: { code: 'EVENT_NOT_FOUND', message: 'Event not found' },
      });
    },
  );

  it('returns 400 for a non-UUID id without touching the database', async () => {
    const res = await request(app).get('/api/events/banana/calendar.ics');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(query).not.toHaveBeenCalled();
  });
});
