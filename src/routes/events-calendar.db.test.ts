/**
 * Calendar export against a real Postgres. Creates its own organizer and events with
 * unique ids and titles, so it does not depend on the seed and can run repeatedly.
 */
import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

function basic(iso: string): string {
  return iso.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function parseCalendar(body: string) {
  expect(body.endsWith('\r\n')).toBe(true);
  expect(body.replace(/\r\n/g, '')).not.toContain('\n');

  const physical = body.slice(0, -2).split('\r\n');
  for (const line of physical) {
    expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
  }

  const lines = body.replace(/\r\n /g, '').slice(0, -2).split('\r\n');
  const eventStart = lines.indexOf('BEGIN:VEVENT');
  const eventEnd = lines.indexOf('END:VEVENT');
  expect(eventStart).toBeGreaterThan(-1);
  expect(eventEnd).toBeGreaterThan(eventStart);

  const properties = new Map<string, string>();
  for (const line of lines.slice(eventStart + 1, eventEnd)) {
    const colon = line.indexOf(':');
    expect(colon).toBeGreaterThan(0);
    properties.set(line.slice(0, colon), line.slice(colon + 1));
  }

  return { lines, properties };
}

describe.skipIf(!TEST_DATABASE_URL)('event calendar export against a real database', () => {
  let app: Express;
  let pool: Pool;
  let webUrl: () => string;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.JWT_SECRET ??= 'test-jwt-secret';
    ({ pool } = await import('../db/pool'));
    const { createApp } = await import('../app');
    app = createApp();
    ({ webUrl } = await import('../lib/mailer'));
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function register(name: string): Promise<{ id: string; token: string }> {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: `${randomUUID()}@test.biletflow.kz`, password: 'test-password', name });
    expect(res.status).toBe(201);
    return { id: res.body.user.id, token: res.body.token };
  }

  async function organizerToken(): Promise<string> {
    const organizer = await register('Calendar Organizer');
    await pool.query('UPDATE users SET email_verified_at = now() WHERE id = $1', [organizer.id]);
    const profile = await request(app)
      .post('/api/me/organizer-profile')
      .set('Authorization', `Bearer ${organizer.token}`)
      .send({
        display_name: 'Calendar Test Organizer',
        contact_email: `${randomUUID()}@test.biletflow.kz`,
      });
    expect(profile.status).toBe(201);
    return profile.body.token as string;
  }

  async function createEvent(
    token: string,
    title: string,
    startsAt: Date,
    endsAt: Date,
    description: string,
  ): Promise<string> {
    const res = await request(app)
      .post('/api/events')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title,
        description,
        venue_name: 'Calendar Test Venue',
        venue_address: '12 Kabanbay Batyr, Astana',
        starts_at: startsAt.toISOString(),
        ends_at: endsAt.toISOString(),
      });
    expect(res.status).toBe(201);
    return res.body.event.id as string;
  }

  it('serves a valid VCALENDAR for a published event', async () => {
    const token = await organizerToken();
    const startsAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
    startsAt.setUTCMilliseconds(0);
    const endsAt = new Date(startsAt.getTime() + 3 * 60 * 60 * 1000);
    const title = `Calendar Published ${randomUUID()}`;
    const description =
      'A real database test event, with punctuation; and a newline.\nSecond line.';
    const eventId = await createEvent(token, title, startsAt, endsAt, description);

    const ticketType = await request(app)
      .post(`/api/events/${eventId}/ticket-types`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Free admission', price: 0, quantity_total: 10 });
    expect(ticketType.status).toBe(201);
    const published = await request(app)
      .post(`/api/events/${eventId}/publish`)
      .set('Authorization', `Bearer ${token}`);
    expect(published.status).toBe(200);

    const res = await request(app).get(`/api/events/${eventId}/calendar.ics`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/calendar; charset=utf-8');
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="calendar-published-[0-9a-f-]+\.ics"$/,
    );

    const { lines, properties } = parseCalendar(res.text);
    expect(lines).toEqual(
      expect.arrayContaining([
        'VERSION:2.0',
        'PRODID:-//BiletFlow//Events//EN',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
      ]),
    );
    expect(properties.get('UID')).toBe(`${eventId}@biletflow`);
    expect(properties.get('DTSTAMP')).toMatch(/^\d{8}T\d{6}Z$/);
    expect(properties.get('DTSTART')).toBe(basic(startsAt.toISOString()));
    expect(properties.get('DTEND')).toBe(basic(endsAt.toISOString()));
    expect(properties.get('SUMMARY')).toBe(title);
    expect(properties.get('LOCATION')).toBe('Calendar Test Venue\\, 12 Kabanbay Batyr\\, Astana');
    expect(properties.get('URL')).toBe(`${webUrl()}/events/${eventId}`);
    expect(properties.get('DESCRIPTION')).toMatch(
      new RegExp(`^A real database test event.*\\\\n\\\\n${webUrl()}/events/${eventId}$`),
    );
  });

  it('answers 404 EVENT_NOT_FOUND for a draft', async () => {
    const token = await organizerToken();
    const startsAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
    const endsAt = new Date(startsAt.getTime() + 2 * 60 * 60 * 1000);
    const eventId = await createEvent(
      token,
      `Calendar Draft ${randomUUID()}`,
      startsAt,
      endsAt,
      'Still a draft, so its calendar is not public.',
    );

    const res = await request(app).get(`/api/events/${eventId}/calendar.ics`);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: { code: 'EVENT_NOT_FOUND', message: 'Event not found' },
    });
  });
});
