/**
 * Counts on a real Postgres, because the three counters (capacity, tickets sold,
 * checked in) are aggregates that a faked pool cannot demonstrate.
 * Skipped when TEST_DATABASE_URL is unset.
 */
import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import type { Pool } from 'pg';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signToken } from '../middleware/auth';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)('organizer events with counts', () => {
  let app: Express;
  let pool: Pool;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.JWT_SECRET ??= 'test-jwt-secret';
    ({ pool } = await import('../db/pool'));
    const { createApp } = await import('../app');
    app = createApp();
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function registerOrganizer(name = 'Organizer'): Promise<{ id: string; token: string }> {
    const id = randomUUID();
    const email = `${randomUUID()}@test.biletflow.kz`;
    const passwordHash = await bcrypt.hash('test-password', 10);
    await pool.query(
      `INSERT INTO users (id, email, password_hash, name, role, email_verified_at)
       VALUES ($1, $2, $3, $4, 'organizer', now())`,
      [id, email, passwordHash, name],
    );
    await pool.query(
      `INSERT INTO organizer_profiles (user_id, display_name, contact_email, contact_phone,
                                       payout_bank_name, payout_iban, payout_account_holder,
                                       identity_verified_at)
       VALUES ($1, 'Test Org', 'org@test.biletflow.kz', null, null, null, null, now())`,
      [id],
    );
    return { id, token: signToken({ id, role: 'organizer' }) };
  }

  async function eventWithTicketTypes(
    token: string,
    quantityTotal: number,
  ): Promise<{ eventId: string; ticketTypeId: string }> {
    const eventRes = await request(app)
      .post('/api/events')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'Test event',
        description: 'A test event.',
        venue_name: 'Test venue',
        venue_address: 'Test address',
        starts_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        ends_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000 + 2 * 60 * 60 * 1000).toISOString(),
      });
    expect(eventRes.status).toBe(201);
    const eventId = eventRes.body.event.id;

    const ttRes = await request(app)
      .post(`/api/events/${eventId}/ticket-types`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'General', price: 0, quantity_total: quantityTotal, is_hidden: false });
    expect(ttRes.status).toBe(201);
    return { eventId, ticketTypeId: ttRes.body.ticket_type.id };
  }

  async function buyAndPay(token: string, eventId: string, ticketTypeId: string) {
    const orderRes = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ event_id: eventId, items: [{ ticket_type_id: ticketTypeId, quantity: 1 }] });
    expect(orderRes.status).toBe(201);
    const orderId = orderRes.body.order.id;
    const payRes = await request(app)
      .post(`/api/orders/${orderId}/pay`)
      .set('Authorization', `Bearer ${token}`);
    expect(payRes.status).toBe(200);
    return payRes.body.order.tickets.map((t: { id: string }) => t.id);
  }

  it('counts capacity, paid tickets sold and checked-in tickets', async () => {
    const { token } = await registerOrganizer();
    const { eventId, ticketTypeId } = await eventWithTicketTypes(token, 100);

    await request(app)
      .post(`/api/events/${eventId}/publish`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const buyer = await registerOrganizer('Buyer');
    const ticketIds = await buyAndPay(buyer.token, eventId, ticketTypeId);

    // Mark one ticket as checked in directly (check-in endpoints belong to another issue).
    await pool.query(`UPDATE tickets SET status = 'checked_in' WHERE id = $1`, [ticketIds[0]]);

    const res = await request(app).get('/api/me/events').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const found = res.body.events.find((e: { id: string }) => e.id === eventId);
    expect(found).toBeDefined();
    expect(found!.capacity).toBe(100);
    expect(found!.tickets_sold).toBe(1);
    expect(found!.checked_in).toBe(1);
  });

  it("shows only the caller's events", async () => {
    const owner = await registerOrganizer();
    const other = await registerOrganizer();
    const { eventId: ownerEvent } = await eventWithTicketTypes(owner.token, 100);
    const { eventId: otherEvent } = await eventWithTicketTypes(other.token, 10);

    const res = await request(app)
      .get('/api/me/events')
      .set('Authorization', `Bearer ${owner.token}`);
    expect(res.status).toBe(200);
    const ids = res.body.events.map((e: { id: string }) => e.id);
    expect(ids).toContain(ownerEvent);
    expect(ids).not.toContain(otherEvent);
  });

  it('lets only the owner reopen a draft and see hidden ticket types', async () => {
    const owner = await registerOrganizer();
    const other = await registerOrganizer();
    const { eventId, ticketTypeId } = await eventWithTicketTypes(owner.token, 10);
    const ownerAuth = { Authorization: `Bearer ${owner.token}` };
    const path = `/api/events/${eventId}`;

    await request(app)
      .patch(`/api/ticket-types/${ticketTypeId}`)
      .set(ownerAuth)
      .send({ is_hidden: true })
      .expect(200);
    await request(app).get(path).expect(404);
    await request(app).get(`${path}/manage`).expect(401);
    await request(app)
      .get(`${path}/manage`)
      .set('Authorization', `Bearer ${other.token}`)
      .expect(404);

    const managed = await request(app).get(`${path}/manage`).set(ownerAuth).expect(200);
    expect(managed.body.event).toMatchObject({
      id: eventId,
      status: 'draft',
      ticket_types: [{ id: ticketTypeId, is_hidden: true }],
    });

    await request(app).post(`${path}/publish`).set(ownerAuth).expect(200);
    const published = await request(app).get(path).expect(200);
    expect(published.body.event.ticket_types).toEqual([]);

    await request(app).post(`${path}/cancel`).set(ownerAuth).expect(200);
    const cancelled = await request(app).get(`${path}/manage`).set(ownerAuth).expect(200);
    expect(cancelled.body.event.status).toBe('cancelled');
    await request(app).get(path).expect(404);
  });

  it('returns an empty list for an organizer with no events', async () => {
    const { token } = await registerOrganizer();
    const res = await request(app).get('/api/me/events').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.events).toEqual([]);
  });
});
