/**
 * Cancellations and refunds against a real Postgres: inventory release, ticket
 * invalidation, the refunds table, audit entries, emails and the races. Skipped
 * without TEST_DATABASE_URL. Setup follows paid-sales.db.test.ts.
 */
import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

interface IssuedTicket {
  id: string;
  status: string;
  qr_payload: string;
}

describe.skipIf(!TEST_DATABASE_URL)('refunds against a real database', () => {
  let app: Express;
  let pool: Pool;
  let eventId: string;
  let paidTypeId: string;
  let freeTypeId: string;
  let organizerToken: string;
  let buyerToken: string;
  let staffToken: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.JWT_SECRET ??= 'test-jwt-secret';
    ({ pool } = await import('../db/pool'));
    const { createApp } = await import('../app');
    app = createApp();

    // The organizer, with a verified identity and a payout account, on a published
    // event with paid sales active and one paid and one free ticket type.
    const organizer = await register('Refund Organizer');
    await pool.query('UPDATE users SET email_verified_at = now() WHERE id = $1', [organizer.id]);
    const profile = await request(app)
      .post('/api/me/organizer-profile')
      .set('Authorization', `Bearer ${organizer.token}`)
      .send({
        display_name: 'Refund Test Organizer',
        contact_email: 'organizer@test.biletflow.kz',
        payout: { bank_name: 'Demo Bank', iban: 'KZ000000000000000000', account_holder: 'Test' },
      });
    expect(profile.status).toBe(201);
    organizerToken = profile.body.token as string;

    const event = await pool.query<{ id: string }>(
      `INSERT INTO events (organizer_id, title, venue_name, venue_address, starts_at, ends_at, status)
       VALUES ($1, 'Refund test event', 'Test venue', 'Test address',
               now() + interval '7 days', now() + interval '7 days 2 hours', 'published')
       RETURNING id`,
      [organizer.id],
    );
    eventId = event.rows[0]!.id;

    const paidType = await request(app)
      .post(`/api/events/${eventId}/ticket-types`)
      .set('Authorization', `Bearer ${organizerToken}`)
      .send({ name: 'Standard', price: 500000, quantity_total: 5 });
    expect(paidType.status).toBe(201);
    paidTypeId = paidType.body.ticket_type.id;

    const freeType = await request(app)
      .post(`/api/events/${eventId}/ticket-types`)
      .set('Authorization', `Bearer ${organizerToken}`)
      .send({ name: 'Free admission', price: 0, quantity_total: 5 });
    expect(freeType.status).toBe(201);
    freeTypeId = freeType.body.ticket_type.id;

    const auth = { Authorization: `Bearer ${organizerToken}` };
    const base = `/api/events/${eventId}/paid-sales`;
    await request(app).post('/api/me/organizer-profile/verify-identity').set(auth).expect(200);
    await request(app).post(`${base}/activation-fee`).set(auth).expect(200);
    await request(app).post(`${base}/terms`).set(auth).send({ accepted: true }).expect(200);
    await request(app).post(`${base}/activate`).set(auth).expect(200);

    const buyer = await register('Refund Buyer');
    buyerToken = buyer.token;

    const staff = await register('Door Staff');
    staffToken = staff.token;
    const assigned = await request(app)
      .post(`/api/events/${eventId}/staff`)
      .set('Authorization', `Bearer ${organizerToken}`)
      .send({ email: staff.email });
    expect(assigned.status).toBe(201);
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function register(name: string): Promise<{ id: string; email: string; token: string }> {
    const email = `${randomUUID()}@test.biletflow.kz`;
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email, password: 'test-password', name });
    expect(res.status).toBe(201);
    return { id: res.body.user.id, email, token: res.body.token };
  }

  function buy(token: string, ticketTypeId: string, quantity: number) {
    return request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ event_id: eventId, items: [{ ticket_type_id: ticketTypeId, quantity }] });
  }

  function pay(token: string, orderId: string) {
    return request(app).post(`/api/orders/${orderId}/pay`).set('Authorization', `Bearer ${token}`);
  }

  function refund(token: string, orderId: string) {
    return request(app)
      .post(`/api/events/${eventId}/orders/${orderId}/refund`)
      .set('Authorization', `Bearer ${token}`);
  }

  function cancelOrder(token: string, orderId: string) {
    return request(app)
      .post(`/api/events/${eventId}/orders/${orderId}/cancel`)
      .set('Authorization', `Bearer ${token}`);
  }

  function scan(ticket: IssuedTicket) {
    return request(app)
      .post('/api/staff/check-in')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ event_id: eventId, qr_payload: ticket.qr_payload });
  }

  // A paid order (quantity x 500000 plus the 3% fee), already through /pay.
  async function paidOrder(
    quantity: number,
  ): Promise<{ orderId: string; tickets: IssuedTicket[] }> {
    const placed = await buy(buyerToken, paidTypeId, quantity);
    expect(placed.status).toBe(201);
    const orderId = placed.body.order.id as string;
    const paid = await pay(buyerToken, orderId);
    expect(paid.status).toBe(200);
    return { orderId, tickets: paid.body.order.tickets as IssuedTicket[] };
  }

  async function buyerOrder(orderId: string) {
    const res = await request(app)
      .get(`/api/orders/${orderId}`)
      .set('Authorization', `Bearer ${buyerToken}`);
    expect(res.status).toBe(200);
    return res.body.order as {
      status: string;
      tickets: IssuedTicket[];
      refund: { amount: number; currency: string } | null;
    };
  }

  async function availableOf(ticketTypeId: string): Promise<number> {
    const res = await request(app).get(`/api/events/${eventId}`);
    expect(res.status).toBe(200);
    const type = res.body.event.ticket_types.find((t: { id: string }) => t.id === ticketTypeId);
    expect(type).toBeDefined();
    return type.quantity_available as number;
  }

  async function refundsRows(orderId: string) {
    const result = await pool.query<{ amount: number; currency: string }>(
      `SELECT amount, currency FROM refunds WHERE order_id = $1`,
      [orderId],
    );
    return result.rows;
  }

  it('refunds a paid order: tickets, seats, refunds row, audit, email, buyer view', async () => {
    expect(await availableOf(paidTypeId)).toBe(5);
    const { orderId } = await paidOrder(2);
    expect(await availableOf(paidTypeId)).toBe(3);

    const refunded = await refund(organizerToken, orderId);
    expect(refunded.status).toBe(200);
    expect(refunded.body.order).toMatchObject({ id: orderId, status: 'refunded' });
    expect(refunded.body.order.refund).toEqual({
      amount: 1030000,
      currency: 'KZT',
      is_demonstration: true,
      refunded_at: expect.any(String),
    });

    expect(await availableOf(paidTypeId)).toBe(5);

    expect(await refundsRows(orderId)).toEqual([{ amount: 1030000, currency: 'KZT' }]);

    const audits = await pool.query<{ actor_id: string; description: string }>(
      `SELECT actor_id, description FROM audit_log
        WHERE action = 'order.refunded' AND entity_type = 'order' AND entity_id = $1`,
      [orderId],
    );
    expect(audits.rows).toHaveLength(1);
    expect(audits.rows[0]!.description).toBe('Refunded 10300.00 KZT (simulated)');

    const inbox = await request(app)
      .get('/api/me/emails')
      .set('Authorization', `Bearer ${buyerToken}`);
    expect(inbox.status).toBe(200);
    const notices = (inbox.body.emails as { kind: string; subject: string; body: string }[]).filter(
      (email) => email.kind === 'refund_completed',
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]!.subject).toBe('Your refund for Refund test event');
    expect(notices[0]!.body).toContain('10300.00 KZT');
    expect(notices[0]!.body).toContain('No real money moves');

    const order = await buyerOrder(orderId);
    expect(order.status).toBe('refunded');
    expect(order.refund).toMatchObject({ amount: 1030000, currency: 'KZT' });
    for (const ticket of order.tickets) {
      expect(ticket.status).toBe('refunded');
    }
  });

  it('scans a refunded ticket at the door as refunded', async () => {
    const { orderId } = await paidOrder(1);
    expect((await refund(organizerToken, orderId)).status).toBe(200);

    const order = await buyerOrder(orderId);
    const ticket = order.tickets[0]!;
    expect(ticket.status).toBe('refunded');

    const scanned = await scan(ticket);
    expect(scanned.status).toBe(200);
    expect(scanned.body.result).toBe('refunded');
  });

  it('refuses a second refund of the same order, keeping one refunds row', async () => {
    const { orderId } = await paidOrder(1);
    expect((await refund(organizerToken, orderId)).status).toBe(200);

    const again = await refund(organizerToken, orderId);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('CONFLICT');
    expect(await refundsRows(orderId)).toHaveLength(1);
  });

  it('lets exactly one of two simultaneous refunds win', async () => {
    const { orderId } = await paidOrder(1);

    const attempts = await Promise.all([
      refund(organizerToken, orderId),
      refund(organizerToken, orderId),
    ]);
    expect(attempts.map((res) => res.status).sort()).toEqual([200, 409]);
    expect(await refundsRows(orderId)).toHaveLength(1);
  });

  it('refuses to refund an order with a checked-in ticket', async () => {
    const { orderId, tickets } = await paidOrder(2);
    const scanned = await scan(tickets[0]!);
    expect(scanned.status).toBe(200);
    expect(scanned.body.result).toBe('valid');

    const refused = await refund(organizerToken, orderId);
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toBe(
      'Some tickets of this order were already used at the door',
    );

    const order = await buyerOrder(orderId);
    expect(order.status).toBe('paid');
    expect(order.tickets.map((ticket) => ticket.status).sort()).toEqual(['checked_in', 'valid']);
    expect(await refundsRows(orderId)).toHaveLength(0);
  });

  it('cancels a free registration, and refuses the wrong endpoint both ways', async () => {
    const placed = await buy(buyerToken, freeTypeId, 2);
    expect(placed.status).toBe(201);
    const orderId = placed.body.order.id as string;
    const paid = await pay(buyerToken, orderId);
    expect(paid.status).toBe(200);
    expect(paid.body.order.total).toBe(0);
    expect(await availableOf(freeTypeId)).toBe(3);

    // Refund on a free registration is the wrong endpoint.
    const wrongEndpoint = await refund(organizerToken, orderId);
    expect(wrongEndpoint.status).toBe(409);
    expect(wrongEndpoint.body.error.message).toBe(
      'This order is a free registration. Cancel it instead of refunding it.',
    );

    const cancelled = await cancelOrder(organizerToken, orderId);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.order).toMatchObject({ id: orderId, status: 'cancelled' });
    expect(await availableOf(freeTypeId)).toBe(5);

    const order = await buyerOrder(orderId);
    for (const ticket of order.tickets) {
      expect(ticket.status).toBe('cancelled');
    }

    const inbox = await request(app)
      .get('/api/me/emails')
      .set('Authorization', `Bearer ${buyerToken}`);
    const notices = (inbox.body.emails as { kind: string; subject: string }[]).filter(
      (email) => email.kind === 'registration_cancelled',
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]!.subject).toBe('Your registration for Refund test event was cancelled');

    // Cancel on a paid order is the wrong endpoint the other way round.
    const { orderId: paidOrderId } = await paidOrder(1);
    const backwards = await cancelOrder(organizerToken, paidOrderId);
    expect(backwards.status).toBe(409);
    expect(backwards.body.error.message).toBe(
      'This order was paid. Refund it instead of cancelling it.',
    );
  });

  it('keeps other organizers out and foreign orders invisible', async () => {
    // A second organizer with an event of their own, and a paid order on it.
    const second = await register('Second Organizer');
    await pool.query('UPDATE users SET email_verified_at = now() WHERE id = $1', [second.id]);
    const secondProfile = await request(app)
      .post('/api/me/organizer-profile')
      .set('Authorization', `Bearer ${second.token}`)
      .send({
        display_name: 'Second Organizer',
        contact_email: 'second@test.biletflow.kz',
      });
    expect(secondProfile.status).toBe(201);
    const secondToken = secondProfile.body.token as string;

    const secondEvent = await pool.query<{ id: string }>(
      `INSERT INTO events (organizer_id, title, venue_name, venue_address, starts_at, ends_at, status)
       VALUES ($1, 'Other test event', 'Test venue', 'Test address',
               now() + interval '7 days', now() + interval '7 days 2 hours', 'published')
       RETURNING id`,
      [second.id],
    );
    const otherEventId = secondEvent.rows[0]!.id;
    const otherType = await request(app)
      .post(`/api/events/${otherEventId}/ticket-types`)
      .set('Authorization', `Bearer ${secondToken}`)
      .send({ name: 'Free admission', price: 0, quantity_total: 5 });
    expect(otherType.status).toBe(201);
    const otherOrder = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({
        event_id: otherEventId,
        items: [{ ticket_type_id: otherType.body.ticket_type.id, quantity: 1 }],
      });
    expect(otherOrder.status).toBe(201);
    const otherOrderId = otherOrder.body.order.id as string;
    const otherPaid = await pay(buyerToken, otherOrderId);
    expect(otherPaid.status).toBe(200);

    // The other organizer cannot manage this event's orders...
    const forbiddenList = await request(app)
      .get(`/api/events/${eventId}/orders`)
      .set('Authorization', `Bearer ${secondToken}`);
    expect(forbiddenList.status).toBe(403);

    const { orderId } = await paidOrder(1);
    const forbiddenRefund = await refund(secondToken, orderId);
    expect(forbiddenRefund.status).toBe(403);

    // ...and an order of another event through this event's URL reads as missing.
    const notFound = await refund(organizerToken, otherOrderId);
    expect(notFound.status).toBe(404);
    expect(notFound.body.error.code).toBe('ORDER_NOT_FOUND');
    expect(await refundsRows(otherOrderId)).toHaveLength(0);
  });

  it('refunds a paid order of a cancelled event', async () => {
    const { orderId } = await paidOrder(1);

    const cancelled = await request(app)
      .post(`/api/events/${eventId}/cancel`)
      .set('Authorization', `Bearer ${organizerToken}`);
    expect(cancelled.status).toBe(200);

    // The event cancel turned the valid tickets into cancelled ones; the paid order
    // itself stays paid and can still be refunded.
    const refunded = await refund(organizerToken, orderId);
    expect(refunded.status).toBe(200);
    expect(refunded.body.order.status).toBe('refunded');

    const order = await buyerOrder(orderId);
    for (const ticket of order.tickets) {
      expect(ticket.status).toBe('refunded');
    }
  });
});
