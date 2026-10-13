/**
 * Orders against a real Postgres, because the thing that matters most here, never
 * overselling when two people buy the last ticket at once, cannot be tested with a
 * faked pool. A fake answers instantly and never waits for a lock.
 *
 * Runs only when TEST_DATABASE_URL is set, and is skipped otherwise. Point it at a
 * database of its own, never at your dev one: every run adds users and events.
 *
 *   docker exec biletflow-db createdb -U biletflow biletflow_test
 *   DATABASE_URL=postgres://biletflow:biletflow@127.0.0.1:5432/biletflow_test npm run migrate
 *   TEST_DATABASE_URL=postgres://biletflow:biletflow@127.0.0.1:5432/biletflow_test npm test
 *
 * CI does the same with a Postgres service container.
 */
import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyTicketPayload } from '../lib/qr';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)('orders against a real database', () => {
  let app: Express;
  let pool: Pool;

  beforeAll(async () => {
    // Set before the pool module loads, because it reads DATABASE_URL on import.
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.JWT_SECRET ??= 'test-jwt-secret';
    ({ pool } = await import('../db/pool'));
    const { createApp } = await import('../app');
    app = createApp();
  });

  afterAll(async () => {
    await pool?.end();
  });

  // A registered user, through the real endpoint, so the token is a real one.
  async function register(name = 'Buyer'): Promise<{ id: string; token: string }> {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: `${randomUUID()}@test.biletflow.kz`, password: 'test-password', name });
    expect(res.status).toBe(201);
    return { id: res.body.user.id, token: res.body.token };
  }

  // A published event a week from now with one ticket type. Written straight into the
  // database: creating events is not what these tests are about.
  async function eventWithTickets(quantityTotal: number, price = 0) {
    const organizer = await register('Organizer');
    const event = await pool.query<{ id: string }>(
      `INSERT INTO events (organizer_id, title, venue_name, venue_address, starts_at, ends_at, status)
       VALUES ($1, 'Test event', 'Test venue', 'Test address',
               now() + interval '7 days', now() + interval '7 days 2 hours', 'published')
       RETURNING id`,
      [organizer.id],
    );
    const eventId = event.rows[0]!.id;
    const ticketType = await pool.query<{ id: string }>(
      `INSERT INTO ticket_types (event_id, name, price, quantity_total)
       VALUES ($1, 'General', $2, $3)
       RETURNING id`,
      [eventId, price, quantityTotal],
    );
    return { eventId, ticketTypeId: ticketType.rows[0]!.id };
  }

  function placeOrder(
    token: string,
    eventId: string,
    ticketTypeId: string,
    quantity: number,
  ): request.Test {
    return request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ event_id: eventId, items: [{ ticket_type_id: ticketTypeId, quantity }] });
  }

  it('registers a user for a free event and issues tickets whose QR verifies', async () => {
    const buyer = await register('Aidos K.');
    const { eventId, ticketTypeId } = await eventWithTickets(50);

    const placed = await placeOrder(buyer.token, eventId, ticketTypeId, 2);
    expect(placed.status).toBe(201);
    expect(placed.body.order).toMatchObject({ status: 'pending', total: 0, tickets: [] });

    const paid = await request(app)
      .post(`/api/orders/${placed.body.order.id}/pay`)
      .set('Authorization', `Bearer ${buyer.token}`);
    expect(paid.status).toBe(200);
    expect(paid.body.order.status).toBe('paid');
    expect(paid.body.order.expires_at).toBeNull();

    const tickets = paid.body.order.tickets as { id: string; qr_payload: string }[];
    expect(tickets).toHaveLength(2);
    for (const ticket of tickets) {
      expect(ticket).toMatchObject({ status: 'valid', attendee_name: 'Aidos K.' });
      expect(verifyTicketPayload(ticket.qr_payload)).toEqual({ ok: true, ticketId: ticket.id });
    }

    const mine = await request(app)
      .get('/api/tickets')
      .set('Authorization', `Bearer ${buyer.token}`);
    expect(mine.body.tickets.map((t: { id: string }) => t.id).sort()).toEqual(
      tickets.map((t) => t.id).sort(),
    );
  });

  it('sells the last ticket exactly once when ten people buy it at the same moment', async () => {
    const { eventId, ticketTypeId } = await eventWithTickets(1);
    const buyers = await Promise.all(Array.from({ length: 10 }, () => register()));

    const results = await Promise.all(
      buyers.map((buyer) => placeOrder(buyer.token, eventId, ticketTypeId, 1)),
    );

    const statuses = results.map((res) => res.status).sort();
    expect(statuses).toEqual([201, ...Array(9).fill(409)]);
    for (const res of results.filter((r) => r.status === 409)) {
      expect(res.body.error.code).toBe('TICKET_SOLD_OUT');
    }
  });

  it('never holds more seats than exist when several buyers race for the rest', async () => {
    // Five seats, ten buyers of two each: two orders fit and the last seat stays free.
    const { eventId, ticketTypeId } = await eventWithTickets(5);
    const buyers = await Promise.all(Array.from({ length: 10 }, () => register()));

    const results = await Promise.all(
      buyers.map((buyer) => placeOrder(buyer.token, eventId, ticketTypeId, 2)),
    );

    expect(results.filter((res) => res.status === 201)).toHaveLength(2);
    const held = await pool.query<{ held: number }>(
      `SELECT COALESCE(SUM(quantity), 0)::int AS held FROM order_items WHERE ticket_type_id = $1`,
      [ticketTypeId],
    );
    expect(held.rows[0]!.held).toBe(4);
  });

  it('issues tickets once when "Pay" is clicked twice at the same moment', async () => {
    const buyer = await register();
    const { eventId, ticketTypeId } = await eventWithTickets(10);
    const placed = await placeOrder(buyer.token, eventId, ticketTypeId, 3);

    const pay = () =>
      request(app)
        .post(`/api/orders/${placed.body.order.id}/pay`)
        .set('Authorization', `Bearer ${buyer.token}`);
    const results = await Promise.all([pay(), pay()]);

    expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
    const count = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM tickets WHERE event_id = $1`,
      [eventId],
    );
    expect(count.rows[0]!.n).toBe(3);
  });

  it('gives the seats of an expired order back, and refuses to pay it', async () => {
    const { eventId, ticketTypeId } = await eventWithTickets(1);
    const first = await register();
    const second = await register();

    const stale = await placeOrder(first.token, eventId, ticketTypeId, 1);
    expect(stale.status).toBe(201);
    expect((await placeOrder(second.token, eventId, ticketTypeId, 1)).status).toBe(409);

    // Ten minutes pass.
    await pool.query(`UPDATE orders SET expires_at = now() - interval '1 second' WHERE id = $1`, [
      stale.body.order.id,
    ]);

    expect((await placeOrder(second.token, eventId, ticketTypeId, 1)).status).toBe(201);

    const read = await request(app)
      .get(`/api/orders/${stale.body.order.id}`)
      .set('Authorization', `Bearer ${first.token}`);
    expect(read.body.order.status).toBe('cancelled');

    const pay = await request(app)
      .post(`/api/orders/${stale.body.order.id}/pay`)
      .set('Authorization', `Bearer ${first.token}`);
    expect(pay.status).toBe(409);
    expect(pay.body.error.code).toBe('ORDER_EXPIRED');
  });
});
