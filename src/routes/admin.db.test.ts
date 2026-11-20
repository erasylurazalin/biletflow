import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)('suspending an event against a real database', () => {
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

  async function register(name: string): Promise<{ id: string; token: string }> {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: `${randomUUID()}@test.biletflow.kz`, password: 'test-password', name });
    expect(res.status).toBe(201);
    return { id: res.body.user.id, token: res.body.token };
  }

  // A published event with one free ticket type, owned by a fresh organizer.
  async function publishedEvent(): Promise<{ eventId: string; ticketTypeId: string }> {
    const organizer = await register('Organizer');
    await pool.query('UPDATE users SET email_verified_at = now() WHERE id = $1', [organizer.id]);
    const profile = await request(app)
      .post('/api/me/organizer-profile')
      .set('Authorization', `Bearer ${organizer.token}`)
      .send({ display_name: 'Test Organizer', contact_email: `${randomUUID()}@test.biletflow.kz` });
    expect(profile.status).toBe(201);
    const auth = `Bearer ${profile.body.token as string}`;

    const startsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const endsAt = new Date(startsAt.getTime() + 2 * 60 * 60 * 1000);
    const created = await request(app)
      .post('/api/events')
      .set('Authorization', auth)
      .send({
        title: `Suspend test ${randomUUID()}`,
        description: 'A real database test event',
        venue_name: 'Test venue',
        venue_address: 'Test address',
        starts_at: startsAt.toISOString(),
        ends_at: endsAt.toISOString(),
      });
    expect(created.status).toBe(201);
    const eventId = created.body.event.id as string;

    const ticketType = await request(app)
      .post(`/api/events/${eventId}/ticket-types`)
      .set('Authorization', auth)
      .send({ name: 'Free admission', price: 0, quantity_total: 10 });
    expect(ticketType.status).toBe(201);

    const published = await request(app)
      .post(`/api/events/${eventId}/publish`)
      .set('Authorization', auth);
    expect(published.status).toBe(200);

    return { eventId, ticketTypeId: ticketType.body.ticket_type.id as string };
  }

  async function order(buyerToken: string, eventId: string, ticketTypeId: string) {
    return request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ event_id: eventId, items: [{ ticket_type_id: ticketTypeId, quantity: 1 }] });
  }

  async function listedIds(): Promise<string[]> {
    const list = await request(app).get('/api/events?limit=100');
    expect(list.status).toBe(200);
    return (list.body.events as { id: string }[]).map((event) => event.id);
  }

  it('hides the event and refuses new orders until the suspension is lifted', async () => {
    const admin = await register('Admin');
    await pool.query(`UPDATE users SET role = 'platform_admin' WHERE id = $1`, [admin.id]);
    const adminAuth = `Bearer ${signToken({ id: admin.id, role: 'platform_admin' })}`;
    const buyer = await register('Buyer');
    const { eventId, ticketTypeId } = await publishedEvent();

    // A ticket sold before the suspension, and a second order still waiting for payment.
    const before = await order(buyer.token, eventId, ticketTypeId);
    expect(before.status).toBe(201);
    const paid = await request(app)
      .post(`/api/orders/${before.body.order.id}/pay`)
      .set('Authorization', `Bearer ${buyer.token}`);
    expect(paid.status).toBe(200);
    const ticketId = paid.body.order.tickets[0].id as string;
    const pending = await order(buyer.token, eventId, ticketTypeId);
    expect(pending.status).toBe(201);

    expect(await listedIds()).toContain(eventId);

    const suspended = await request(app)
      .post(`/api/admin/events/${eventId}/suspend`)
      .set('Authorization', adminAuth);
    expect(suspended.status).toBe(200);
    expect(suspended.body.event).toMatchObject({
      id: eventId,
      status: 'published',
      suspended: true,
    });
    expect(suspended.body.event.suspended_at).toEqual(expect.any(String));

    expect(await listedIds()).not.toContain(eventId);
    const detail = await request(app).get(`/api/events/${eventId}`);
    expect(detail.status).toBe(404);
    expect(detail.body.error.code).toBe('EVENT_NOT_FOUND');

    const refused = await order(buyer.token, eventId, ticketTypeId);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('CONFLICT');

    // Existing tickets and orders stay as they are.
    const ticket = await request(app)
      .get(`/api/tickets/${ticketId}`)
      .set('Authorization', `Bearer ${buyer.token}`);
    expect(ticket.status).toBe(200);
    expect(ticket.body.ticket.status).toBe('valid');
    const stillPending = await request(app)
      .get(`/api/orders/${pending.body.order.id}`)
      .set('Authorization', `Bearer ${buyer.token}`);
    expect(stillPending.status).toBe(200);
    expect(stillPending.body.order.status).toBe('pending');

    const again = await request(app)
      .post(`/api/admin/events/${eventId}/suspend`)
      .set('Authorization', adminAuth);
    expect(again.status).toBe(409);

    const lifted = await request(app)
      .post(`/api/admin/events/${eventId}/unsuspend`)
      .set('Authorization', adminAuth);
    expect(lifted.status).toBe(200);
    expect(lifted.body.event).toMatchObject({
      status: 'published',
      suspended: false,
      suspended_at: null,
    });

    expect(await listedIds()).toContain(eventId);
    const restored = await order(buyer.token, eventId, ticketTypeId);
    expect(restored.status).toBe(201);

    const notSuspended = await request(app)
      .post(`/api/admin/events/${eventId}/unsuspend`)
      .set('Authorization', adminAuth);
    expect(notSuspended.status).toBe(409);

    const audits = await pool.query<{ action: string; actor_id: string }>(
      `SELECT action, actor_id FROM audit_log
        WHERE event_id = $1 AND action IN ('event.suspended', 'event.unsuspended')
        ORDER BY created_at, action DESC`,
      [eventId],
    );
    expect(audits.rows.map((row) => row.action).sort()).toEqual([
      'event.suspended',
      'event.unsuspended',
    ]);
    expect(audits.rows.every((row) => row.actor_id === admin.id)).toBe(true);
  });

  it('lets only a platform admin suspend', async () => {
    const stranger = await register('Stranger');
    const { eventId } = await publishedEvent();

    const attendee = await request(app)
      .post(`/api/admin/events/${eventId}/suspend`)
      .set('Authorization', `Bearer ${stranger.token}`);
    expect(attendee.status).toBe(403);

    const anonymous = await request(app).post(`/api/admin/events/${eventId}/suspend`);
    expect(anonymous.status).toBe(401);

    expect(await listedIds()).toContain(eventId);
  });
});
