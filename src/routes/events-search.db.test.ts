/**
 * Public event search and filters against a real Postgres: text matching across the
 * four searchable fields, literal wildcards, local-day date ranges, the free filter,
 * visibility rules, paging and the total count. Skipped when TEST_DATABASE_URL is unset.
 */
import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const HOUR_MS = 60 * 60 * 1000;

describe.skipIf(!TEST_DATABASE_URL)('event search filters against a real database', () => {
  let app: Express;
  let pool: Pool;
  let owner: { id: string; token: string };
  const run = randomUUID();
  const marker = (label: string) => `${label}-${run}`;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.JWT_SECRET ??= 'test-jwt-secret';
    ({ pool } = await import('../db/pool'));
    const { createApp } = await import('../app');
    app = createApp();

    const email = `${randomUUID()}@test.biletflow.kz`;
    const registered = await request(app)
      .post('/api/auth/register')
      .send({ email, password: 'test-password', name: 'Search Organizer' });
    expect(registered.status).toBe(201);
    const id = registered.body.user.id as string;
    await pool.query('UPDATE users SET email_verified_at = now() WHERE id = $1', [id]);
    const profile = await request(app)
      .post('/api/me/organizer-profile')
      .set('Authorization', `Bearer ${registered.body.token as string}`)
      .send({ display_name: `Search Org ${randomUUID()}`, contact_email: email });
    expect(profile.status).toBe(201);
    owner = { id, token: profile.body.token as string };
  });

  afterAll(async () => {
    await pool?.end();
  });

  interface TicketTypeInput {
    name: string;
    price: number;
    is_hidden?: boolean;
  }

  interface EventInput {
    title: string;
    description?: string;
    venueName?: string;
    venueAddress?: string;
    startsAt?: Date;
    publish?: boolean;
  }

  async function createEvent(
    input: EventInput,
    ticketTypes: TicketTypeInput[] = [{ name: 'General admission', price: 0 }],
  ): Promise<string> {
    const startsAt = input.startsAt ?? new Date(Date.now() + 30 * 24 * HOUR_MS);
    const created = await request(app)
      .post('/api/events')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({
        title: input.title,
        description: input.description ?? 'A real database search test event.',
        venue_name: input.venueName ?? 'Test venue',
        venue_address: input.venueAddress ?? 'Test address',
        starts_at: startsAt.toISOString(),
        ends_at: new Date(startsAt.getTime() + 2 * HOUR_MS).toISOString(),
      });
    expect(created.status).toBe(201);
    const eventId = created.body.event.id as string;

    for (const type of ticketTypes) {
      const ticketType = await request(app)
        .post(`/api/events/${eventId}/ticket-types`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({
          name: type.name,
          price: type.price,
          quantity_total: 20,
          is_hidden: type.is_hidden ?? false,
        });
      expect(ticketType.status).toBe(201);
    }

    if (input.publish !== false) {
      await request(app)
        .post(`/api/events/${eventId}/publish`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);
    }
    return eventId;
  }

  async function search(query: Record<string, string | number>): Promise<{
    ids: string[];
    total: number;
    status: number;
  }> {
    const res = await request(app)
      .get('/api/events')
      .query({ limit: 100, ...query });
    return {
      ids: (res.body.events as { id: string }[] | undefined)?.map((event) => event.id) ?? [],
      total: res.body.total as number,
      status: res.status,
    };
  }

  it('matches title, description, venue and address case-insensitively and counts them', async () => {
    // Stored in upper case, searched in lower case. Each event carries the marker in
    // exactly one of the four searchable fields.
    const text = marker('find').toUpperCase();
    const titleId = await createEvent({ title: `Title field ${text}` });
    const descriptionId = await createEvent({
      title: 'Description field event',
      description: `Description field ${text}`,
    });
    const venueId = await createEvent({
      title: 'Venue field event',
      venueName: `Venue field ${text}`,
    });
    const addressId = await createEvent({
      title: 'Address field event',
      venueAddress: `Almaty ${text}`,
    });

    const found = await search({ q: text.toLowerCase() });
    expect(found.status).toBe(200);
    expect(found.ids.sort()).toEqual([titleId, descriptionId, venueId, addressId].sort());
    expect(found.total).toBe(4);

    // Paging changes the page, never the total.
    const page = await search({ q: text.toLowerCase(), limit: 2, offset: 10 });
    expect(page.status).toBe(200);
    expect(page.ids).toEqual([]);
    expect(page.total).toBe(4);

    const firstPage = await search({ q: text.toLowerCase(), limit: 2, offset: 0 });
    expect(firstPage.ids).toHaveLength(2);
    expect(firstPage.total).toBe(4);
  });

  it('treats a percent sign in q as a literal character', async () => {
    const text = marker('percent');
    const literalId = await createEvent({ title: `Sale 50% ${text}` });
    await createEvent({ title: `Sale 50x ${text}` });

    const found = await search({ q: `50% ${text}` });
    expect(found.status).toBe(200);
    expect(found.ids).toEqual([literalId]);
    expect(found.total).toBe(1);
  });

  it('includes 23:30 local on the to day and excludes the next local day', async () => {
    const text = marker('dates');
    // 2035-05-15 23:30 and 2035-05-16 00:30 in Asia/Almaty (UTC+5).
    const lateId = await createEvent({
      title: `Late on the to day ${text}`,
      startsAt: new Date('2035-05-15T18:30:00Z'),
    });
    const nextId = await createEvent({
      title: `Next local day ${text}`,
      startsAt: new Date('2035-05-15T19:30:00Z'),
    });

    const toDay = await search({ q: text, from: '2035-05-15', to: '2035-05-15' });
    expect(toDay.status).toBe(200);
    expect(toDay.ids).toEqual([lateId]);
    expect(toDay.total).toBe(1);

    const nextDay = await search({ q: text, from: '2035-05-16', to: '2035-05-16' });
    expect(nextDay.status).toBe(200);
    expect(nextDay.ids).toEqual([nextId]);
  });

  it('free=true needs a visible zero-price ticket type', async () => {
    const text = marker('free');
    const visibleFreeId = await createEvent({ title: `Visible free ${text}` }, [
      { name: 'Free entry', price: 0, is_hidden: false },
    ]);
    await createEvent({ title: `Hidden free only ${text}` }, [
      { name: 'Hidden free entry', price: 0, is_hidden: true },
      { name: 'Paid entry', price: 500000, is_hidden: false },
    ]);
    await createEvent({ title: `Paid only ${text}` }, [
      { name: 'Paid entry', price: 500000, is_hidden: false },
    ]);

    const all = await search({ q: text });
    expect(all.ids).toHaveLength(3);

    const freeOnly = await search({ q: text, free: 'true' });
    expect(freeOnly.status).toBe(200);
    expect(freeOnly.ids).toEqual([visibleFreeId]);
    expect(freeOnly.total).toBe(1);
  });

  it('never lists drafts or suspended events', async () => {
    const text = marker('visible');
    const publishedId = await createEvent({ title: `Published ${text}` });
    await createEvent({ title: `Draft ${text}`, publish: false });
    const suspendedId = await createEvent({ title: `Suspended ${text}` });
    await pool.query(`UPDATE events SET suspended_at = now(), suspended_by = $2 WHERE id = $1`, [
      suspendedId,
      owner.id,
    ]);

    const found = await search({ q: text });
    expect(found.status).toBe(200);
    expect(found.ids).toEqual([publishedId]);
    expect(found.total).toBe(1);
  });
});
