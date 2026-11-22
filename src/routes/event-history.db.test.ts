/**
 * Event history against a real Postgres: the timeline after a seeded-style flow,
 * authorization for staff and admins, phase classification, and duplication.
 * Skipped when TEST_DATABASE_URL is unset.
 */
import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

describe.skipIf(!TEST_DATABASE_URL)('organizer event history against a real database', () => {
  let app: Express;
  let pool: Pool;
  let signToken: typeof import('../middleware/auth').signToken;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.JWT_SECRET ??= 'test-jwt-secret';
    ({ pool } = await import('../db/pool'));
    ({ signToken } = await import('../middleware/auth'));
    const { createApp } = await import('../app');
    app = createApp();
  });

  afterAll(async () => {
    await pool?.end();
  });

  interface User {
    id: string;
    email: string;
    token: string;
  }

  async function register(name = 'Organizer'): Promise<User> {
    const email = `${randomUUID()}@test.biletflow.kz`;
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email, password: 'test-password', name });
    expect(res.status).toBe(201);
    return { id: res.body.user.id as string, email, token: res.body.token as string };
  }

  async function organizer(): Promise<User> {
    const user = await register('Test Organizer');
    await pool.query('UPDATE users SET email_verified_at = now() WHERE id = $1', [user.id]);
    const profile = await request(app)
      .post('/api/me/organizer-profile')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ display_name: `Test Org ${randomUUID()}`, contact_email: user.email });
    expect(profile.status).toBe(201);
    return { ...user, token: profile.body.token as string };
  }

  async function createEvent(
    token: string,
    startsAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
    endsAt = new Date(startsAt.getTime() + 2 * 60 * 60 * 1000),
  ): Promise<string> {
    const res = await request(app)
      .post('/api/events')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: `History test ${randomUUID()}`,
        description: 'A real database test event.',
        venue_name: 'Test venue',
        venue_address: 'Test address',
        starts_at: startsAt.toISOString(),
        ends_at: endsAt.toISOString(),
      });
    expect(res.status).toBe(201);
    return res.body.event.id as string;
  }

  async function addTicketType(
    token: string,
    eventId: string,
    input: Record<string, unknown> = {},
  ): Promise<string> {
    const res = await request(app)
      .post(`/api/events/${eventId}/ticket-types`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'General admission', price: 0, quantity_total: 10, ...input });
    expect(res.status).toBe(201);
    return res.body.ticket_type.id as string;
  }

  async function publish(token: string, eventId: string): Promise<void> {
    await request(app)
      .post(`/api/events/${eventId}/publish`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  }

  async function buy(token: string, eventId: string, ticketTypeId: string): Promise<void> {
    const order = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ event_id: eventId, items: [{ ticket_type_id: ticketTypeId, quantity: 1 }] });
    expect(order.status).toBe(201);
    const paid = await request(app)
      .post(`/api/orders/${order.body.order.id}/pay`)
      .set('Authorization', `Bearer ${token}`);
    expect(paid.status).toBe(200);
  }

  function almatyToday(): string {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Almaty',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const read = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((part) => part.type === type)?.value ?? '';
    return `${read('year')}-${read('month')}-${read('day')}`;
  }

  it('lists the seeded-style flow, filters, and authorizes staff and admins', async () => {
    const owner = await organizer();
    const eventId = await createEvent(owner.token);
    const ticketTypeId = await addTicketType(owner.token, eventId);
    await publish(owner.token, eventId);

    const buyer = await register('Buyer');
    await buy(buyer.token, eventId, ticketTypeId);

    const staff = await register('Door staff');
    const assigned = await request(app)
      .post(`/api/events/${eventId}/staff`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ email: staff.email });
    expect(assigned.status).toBe(201);

    await request(app)
      .post(`/api/events/${eventId}/cancel`)
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(200);

    const res = await request(app)
      .get(`/api/events/${eventId}/timeline?limit=100`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ limit: 100, offset: 0 });
    const actions = (res.body.entries as { action: string }[]).map((entry) => entry.action);
    expect(actions).toEqual(
      expect.arrayContaining(['event.created', 'event.published', 'order.paid', 'event.cancelled']),
    );
    expect(res.body.actions).toEqual(expect.arrayContaining(actions));

    // Newest first.
    const timestamps = (res.body.entries as { created_at: string }[]).map((entry) =>
      new Date(entry.created_at).getTime(),
    );
    expect(timestamps).toEqual([...timestamps].sort((a, b) => b - a));

    const cancelled = (res.body.entries as Record<string, unknown>[]).find(
      (entry) => entry.action === 'event.cancelled',
    );
    expect(cancelled).toMatchObject({
      entity_type: 'event',
      entity_id: eventId,
      actor: { id: owner.id, name: 'Test Organizer' },
    });

    const byAction = await request(app)
      .get(`/api/events/${eventId}/timeline?action=event.cancelled`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(byAction.status).toBe(200);
    expect(byAction.body.entries.length).toBeGreaterThan(0);
    expect(
      (byAction.body.entries as { action: string }[]).every(
        (entry) => entry.action === 'event.cancelled',
      ),
    ).toBe(true);

    const today = almatyToday();
    const inRange = await request(app)
      .get(`/api/events/${eventId}/timeline?from=${today}&to=${today}`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(inRange.status).toBe(200);
    expect(inRange.body.entries.length).toBeGreaterThan(0);

    const outside = await request(app)
      .get(`/api/events/${eventId}/timeline?from=2000-01-01&to=2000-01-02`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(outside.status).toBe(200);
    expect(outside.body.entries).toEqual([]);

    // Door staff and platform admins may read it. A cancelled and suspended event still
    // answers: history is for review after the event is over.
    await request(app)
      .get(`/api/events/${eventId}/timeline`)
      .set('Authorization', `Bearer ${staff.token}`)
      .expect(200);

    const admin = await register('Admin');
    await pool.query(`UPDATE users SET role = 'platform_admin' WHERE id = $1`, [admin.id]);
    const adminToken = signToken({ id: admin.id, role: 'platform_admin' });
    await request(app)
      .post(`/api/admin/events/${eventId}/suspend`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    await request(app)
      .get(`/api/events/${eventId}/timeline`)
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(200);
    await request(app)
      .get(`/api/events/${eventId}/timeline`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const other = await organizer();
    const notMine = await request(app)
      .get(`/api/events/${eventId}/timeline`)
      .set('Authorization', `Bearer ${other.token}`);
    expect(notMine.status).toBe(404);
    expect(notMine.body.error.code).toBe('EVENT_NOT_FOUND');

    await request(app).get(`/api/events/${eventId}/timeline`).expect(401);

    const unknown = await request(app)
      .get(`/api/events/${randomUUID()}/timeline`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(unknown.status).toBe(404);
  });

  it('returns one event per phase and filters by phase', async () => {
    const owner = await organizer();
    const draftId = await createEvent(owner.token);

    const upcomingId = await createEvent(owner.token);
    await addTicketType(owner.token, upcomingId);
    await publish(owner.token, upcomingId);

    const activeId = await createEvent(owner.token);
    await pool.query(
      `UPDATE events
          SET status = 'published',
              starts_at = now() - interval '1 hour',
              ends_at = now() + interval '1 hour'
        WHERE id = $1`,
      [activeId],
    );

    const completedId = await createEvent(owner.token);
    await pool.query(
      `UPDATE events
          SET status = 'published',
              starts_at = now() - interval '2 hours',
              ends_at = now() - interval '1 hour'
        WHERE id = $1`,
      [completedId],
    );

    const cancelledId = await createEvent(owner.token);
    await request(app)
      .post(`/api/events/${cancelledId}/cancel`)
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(200);

    const res = await request(app)
      .get('/api/me/events?limit=100')
      .set('Authorization', `Bearer ${owner.token}`);
    expect(res.status).toBe(200);
    const phases = new Map(
      (res.body.events as { id: string; phase: string }[]).map((event) => [event.id, event.phase]),
    );
    expect(phases.get(draftId)).toBe('draft');
    expect(phases.get(upcomingId)).toBe('upcoming');
    expect(phases.get(activeId)).toBe('active');
    expect(phases.get(completedId)).toBe('completed');
    expect(phases.get(cancelledId)).toBe('cancelled');

    const filtered = await request(app)
      .get('/api/me/events?phase=completed&limit=100')
      .set('Authorization', `Bearer ${owner.token}`);
    expect(filtered.status).toBe(200);
    expect(filtered.body.events.map((event: { id: string }) => event.id)).toContain(completedId);
    expect(
      (filtered.body.events as { phase: string }[]).every((event) => event.phase === 'completed'),
    ).toBe(true);
  });

  it('duplicates a past event into a clean draft with the same ticket types', async () => {
    const owner = await organizer();
    const startsAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
    const sourceId = await createEvent(owner.token, startsAt);
    const freeType = await addTicketType(owner.token, sourceId, {
      name: 'Free entry',
      price: 0,
      quantity_total: 12,
      is_hidden: false,
    });
    const paidType = await addTicketType(owner.token, sourceId, {
      name: 'VIP',
      price: 750000,
      quantity_total: 4,
      is_hidden: true,
      sales_start_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      sales_end_at: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString(),
    });
    await publish(owner.token, sourceId);

    const buyer = await register('Buyer');
    await buy(buyer.token, sourceId, freeType);

    // Data that must not travel with the copy.
    await request(app)
      .post(`/api/events/${sourceId}/staff`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ email: buyer.email })
      .expect(201);
    await pool.query(
      `INSERT INTO promo_campaigns (event_id, name, code, token, discount_type, discount_value, created_by)
       VALUES ($1, 'Old campaign', $2, $3, 'percent', 10, $4)`,
      [sourceId, `OLD${randomUUID().slice(0, 6).toUpperCase()}`, randomUUID(), owner.id],
    );
    await pool.query(
      `INSERT INTO paid_sales_activations (event_id, terms_accepted_at, terms_accepted_by,
                                           activated_at, activated_by)
       VALUES ($1, now(), $2, now(), $2)`,
      [sourceId, owner.id],
    );
    await pool.query(
      `INSERT INTO payments (purpose, event_id, paid_by, amount, method)
       VALUES ('activation_fee', $1, $2, 500000, 'simulated')`,
      [sourceId, owner.id],
    );
    await pool.query(`UPDATE events SET suspended_at = now(), suspended_by = $2 WHERE id = $1`, [
      sourceId,
      owner.id,
    ]);
    await request(app)
      .post(`/api/events/${sourceId}/cancel`)
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(200);

    const sourceBefore = await pool.query(
      `SELECT title, description, venue_name, venue_address, starts_at, ends_at, status,
              cover_image_url, refund_policy
         FROM events WHERE id = $1`,
      [sourceId],
    );
    const typesBefore = await pool.query(
      `SELECT name, price, currency, quantity_total, is_hidden, sales_start_at, sales_end_at
         FROM ticket_types WHERE event_id = $1 ORDER BY name`,
      [sourceId],
    );

    const res = await request(app)
      .post(`/api/events/${sourceId}/duplicate`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(res.status).toBe(201);
    const copy = res.body.event as {
      id: string;
      status: string;
      starts_at: string;
      suspended?: unknown;
      ticket_types: Record<string, unknown>[];
    };
    expect(copy.status).toBe('draft');
    expect(copy.id).not.toBe(sourceId);
    expect(new Date(copy.starts_at).getTime()).toBeGreaterThan(Date.now());
    expect(copy).not.toHaveProperty('suspended_at');

    const copiedTypes = copy.ticket_types
      .map((type) => ({
        name: type.name,
        price: type.price,
        quantity_total: type.quantity_total,
        is_hidden: type.is_hidden,
      }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    expect(copiedTypes).toEqual([
      { name: 'Free entry', price: 0, quantity_total: 12, is_hidden: false },
      { name: 'VIP', price: 750000, quantity_total: 4, is_hidden: true },
    ]);
    expect(copy.ticket_types.every((type) => type.quantity_available === type.quantity_total)).toBe(
      true,
    );

    const counts = await pool.query<{
      orders: number;
      tickets: number;
      payments: number;
      campaigns: number;
      staff: number;
      activations: number;
      suspended_at: Date | null;
    }>(
      `SELECT
         (SELECT count(*)::int FROM orders WHERE event_id = $1) AS orders,
         (SELECT count(*)::int FROM tickets WHERE event_id = $1) AS tickets,
         (SELECT count(*)::int FROM payments WHERE event_id = $1) AS payments,
         (SELECT count(*)::int FROM promo_campaigns WHERE event_id = $1) AS campaigns,
         (SELECT count(*)::int FROM event_staff WHERE event_id = $1) AS staff,
         (SELECT count(*)::int FROM paid_sales_activations WHERE event_id = $1) AS activations,
         (SELECT suspended_at FROM events WHERE id = $1) AS suspended_at`,
      [copy.id],
    );
    expect(counts.rows[0]).toEqual({
      orders: 0,
      tickets: 0,
      payments: 0,
      campaigns: 0,
      staff: 0,
      activations: 0,
      suspended_at: null,
    });

    const audit = await pool.query<{ action: string; description: string }>(
      `SELECT action, description FROM audit_log WHERE event_id = $1 ORDER BY created_at`,
      [copy.id],
    );
    expect(audit.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'event.created' }),
        expect.objectContaining({
          action: 'event.duplicated',
          description: expect.stringContaining(sourceId),
        }),
      ]),
    );

    // The source is untouched.
    const sourceAfter = await pool.query(
      `SELECT title, description, venue_name, venue_address, starts_at, ends_at, status,
              cover_image_url, refund_policy
         FROM events WHERE id = $1`,
      [sourceId],
    );
    expect(sourceAfter.rows).toEqual(sourceBefore.rows);
    const typesAfter = await pool.query(
      `SELECT name, price, currency, quantity_total, is_hidden, sales_start_at, sales_end_at
         FROM ticket_types WHERE event_id = $1 ORDER BY name`,
      [sourceId],
    );
    expect(typesAfter.rows).toEqual(typesBefore.rows);
    const sourceOrders = await pool.query(`SELECT id FROM orders WHERE event_id = $1 ORDER BY id`, [
      sourceId,
    ]);
    expect(sourceOrders.rows.length).toBeGreaterThan(0);
    expect(paidType).not.toBe(freeType);

    const other = await organizer();
    const forbidden = await request(app)
      .post(`/api/events/${sourceId}/duplicate`)
      .set('Authorization', `Bearer ${other.token}`);
    expect(forbidden.status).toBe(404);
    expect(forbidden.body.error.code).toBe('EVENT_NOT_FOUND');

    const unknown = await request(app)
      .post(`/api/events/${randomUUID()}/duplicate`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(unknown.status).toBe(404);
  });

  it('moves a past start forward by whole weeks and keeps the weekday and time', async () => {
    const owner = await organizer();
    const sourceStart = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const sourceEnd = new Date(sourceStart.getTime() + 2 * 60 * 60 * 1000);
    const sourceId = await createEvent(owner.token, sourceStart, sourceEnd);
    const typeId = await addTicketType(owner.token, sourceId, {
      sales_start_at: new Date(sourceStart.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString(),
      sales_end_at: new Date(sourceStart.getTime() - 24 * 60 * 60 * 1000).toISOString(),
    });
    const sourceType = await pool.query<{ sales_start_at: Date; sales_end_at: Date }>(
      `SELECT sales_start_at, sales_end_at FROM ticket_types WHERE id = $1`,
      [typeId],
    );

    const res = await request(app)
      .post(`/api/events/${sourceId}/duplicate`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(res.status).toBe(201);
    const startsAt = new Date(res.body.event.starts_at as string);
    const endsAt = new Date(res.body.event.ends_at as string);
    const shift = startsAt.getTime() - sourceStart.getTime();

    expect(startsAt.getTime()).toBeGreaterThan(Date.now());
    expect(shift).toBeGreaterThan(0);
    expect(shift % WEEK_MS).toBe(0);
    expect(endsAt.getTime() - sourceEnd.getTime()).toBe(shift);
    expect(startsAt.getUTCDay()).toBe(sourceStart.getUTCDay());
    expect(startsAt.getUTCHours()).toBe(sourceStart.getUTCHours());
    expect(startsAt.getUTCMinutes()).toBe(sourceStart.getUTCMinutes());

    const copiedType = res.body.event.ticket_types[0] as {
      sales_start_at: string;
      sales_end_at: string;
    };
    expect(
      new Date(copiedType.sales_start_at).getTime() -
        (sourceType.rows[0]!.sales_start_at as Date).getTime(),
    ).toBe(shift);
    expect(
      new Date(copiedType.sales_end_at).getTime() -
        (sourceType.rows[0]!.sales_end_at as Date).getTime(),
    ).toBe(shift);
  });
});
