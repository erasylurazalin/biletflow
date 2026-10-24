/**
 * Paid checkout against a real Postgres, end to end through the API: an organizer
 * activates paid sales, an attendee buys a paid ticket through pending and pay, and an
 * expired order gives its seats back and never produces tickets.
 *
 * Runs only when TEST_DATABASE_URL is set. Setup is in orders.db.test.ts.
 */
import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyTicketPayload } from '../lib/qr';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)('paid checkout against a real database', () => {
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

  async function register(name: string): Promise<{ id: string; token: string }> {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: `${randomUUID()}@test.biletflow.kz`, password: 'test-password', name });
    expect(res.status).toBe(201);
    return { id: res.body.user.id, token: res.body.token };
  }

  // An organizer with a payout account, a published event and one paid ticket type,
  // made through the API except the event, which has no create endpoint yet.
  async function organizerWithPaidEvent(quantityTotal: number) {
    const user = await register('Organizer');
    await pool.query('UPDATE users SET email_verified_at = now() WHERE id = $1', [user.id]);
    const profile = await request(app)
      .post('/api/me/organizer-profile')
      .set('Authorization', `Bearer ${user.token}`)
      .send({
        display_name: 'Test Organizer',
        contact_email: 'organizer@test.biletflow.kz',
        payout: { bank_name: 'Demo Bank', iban: 'KZ000000000000000000', account_holder: 'Test' },
      });
    expect(profile.status).toBe(201);
    const token = profile.body.token as string;

    const event = await pool.query<{ id: string }>(
      `INSERT INTO events (organizer_id, title, venue_name, venue_address, starts_at, ends_at, status)
       VALUES ($1, 'Paid test event', 'Test venue', 'Test address',
               now() + interval '7 days', now() + interval '7 days 2 hours', 'published')
       RETURNING id`,
      [user.id],
    );
    const eventId = event.rows[0]!.id;

    const ticketType = await request(app)
      .post(`/api/events/${eventId}/ticket-types`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Standard', price: 500000, quantity_total: quantityTotal });
    expect(ticketType.status).toBe(201);

    return { token, eventId, ticketTypeId: ticketType.body.ticket_type.id as string };
  }

  async function activate(token: string, eventId: string): Promise<void> {
    const auth = { Authorization: `Bearer ${token}` };
    const base = `/api/events/${eventId}/paid-sales`;
    await request(app).post('/api/me/organizer-profile/verify-identity').set(auth).expect(200);
    await request(app).post(`${base}/activation-fee`).set(auth).expect(200);
    await request(app).post(`${base}/terms`).set(auth).send({ accepted: true }).expect(200);
    await request(app).post(`${base}/activate`).set(auth).expect(200);
  }

  function placeOrder(token: string, eventId: string, ticketTypeId: string, quantity: number) {
    return request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ event_id: eventId, items: [{ ticket_type_id: ticketTypeId, quantity }] });
  }

  function pay(token: string, orderId: string) {
    return request(app).post(`/api/orders/${orderId}/pay`).set('Authorization', `Bearer ${token}`);
  }

  it('refuses paid tickets before activation, then sells them through pending and pay', async () => {
    const organizer = await organizerWithPaidEvent(10);
    const buyer = await register('Aidos K.');
    const base = `/api/events/${organizer.eventId}/paid-sales`;
    const auth = { Authorization: `Bearer ${organizer.token}` };

    // Before activation: paid tickets cannot be bought (SRS 4.5).
    const early = await placeOrder(buyer.token, organizer.eventId, organizer.ticketTypeId, 1);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('PAID_SALES_INACTIVE');

    // Activating too soon names what is missing and writes no audit entry.
    const tooSoon = await request(app).post(`${base}/activate`).set(auth);
    expect(tooSoon.status).toBe(409);
    expect(tooSoon.body.error.code).toBe('PAID_SALES_INCOMPLETE');
    expect(tooSoon.body.error.message).toContain('identity verification');
    const failedActivationAudits = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_log
        WHERE event_id = $1 AND action = 'paid_sales.activated'`,
      [organizer.eventId],
    );
    expect(failedActivationAudits.rows[0]!.n).toBe(0);

    await activate(organizer.token, organizer.eventId);

    const checklist = await request(app).get(base).set(auth);
    expect(checklist.body.paid_sales).toMatchObject({
      status: 'active',
      checklist: {
        paid_ticket_type: true,
        identity_verified: true,
        payout_account: true,
        activation_fee_paid: true,
        terms_accepted: true,
      },
      activation_fee: { payment: { method: 'simulated', is_demonstration: true, amount: 500000 } },
    });
    const detail = await request(app).get(`/api/events/${organizer.eventId}`);
    expect(detail.body.event.paid_sales_active).toBe(true);

    // Repeating a completed step changes nothing and adds no audit entry.
    await request(app).post(`${base}/activate`).set(auth).expect(200);
    await request(app).post(`${base}/activation-fee`).set(auth).expect(409);
    const audits = await pool.query<{
      action: string;
      entity_type: string;
      event_id: string | null;
    }>(
      `SELECT action, entity_type, event_id FROM audit_log
        WHERE actor_id = (SELECT organizer_id FROM events WHERE id = $1)`,
      [organizer.eventId],
    );
    expect(audits.rows).toHaveLength(3);
    expect(audits.rows).toEqual(
      expect.arrayContaining([
        {
          action: 'organizer_profile.identity_verified',
          entity_type: 'organizer_profile',
          event_id: null,
        },
        { action: 'paid_sales.fee_paid', entity_type: 'payment', event_id: organizer.eventId },
        { action: 'paid_sales.activated', entity_type: 'event', event_id: organizer.eventId },
      ]),
    );

    // After activation: pending, then pay.
    const placed = await placeOrder(buyer.token, organizer.eventId, organizer.ticketTypeId, 2);
    expect(placed.status).toBe(201);
    expect(placed.body.order).toMatchObject({ status: 'pending', total: 1000000, payment: null });

    const paid = await pay(buyer.token, placed.body.order.id);
    expect(paid.status).toBe(200);
    expect(paid.body.order).toMatchObject({
      status: 'paid',
      payment: { method: 'simulated', is_demonstration: true, amount: 1000000, currency: 'KZT' },
    });
    const tickets = paid.body.order.tickets as { id: string; qr_payload: string }[];
    expect(tickets).toHaveLength(2);
    for (const ticket of tickets) {
      expect(verifyTicketPayload(ticket.qr_payload)).toEqual({ ok: true, ticketId: ticket.id });
    }
  });

  it('gives the seats of an expired paid order back and never issues its tickets', async () => {
    const organizer = await organizerWithPaidEvent(1);
    await activate(organizer.token, organizer.eventId);
    const slow = await register('Slow buyer');
    const fast = await register('Fast buyer');

    const stale = await placeOrder(slow.token, organizer.eventId, organizer.ticketTypeId, 1);
    expect(stale.status).toBe(201);
    // The last seat is held.
    expect(
      (await placeOrder(fast.token, organizer.eventId, organizer.ticketTypeId, 1)).status,
    ).toBe(409);

    // Fifteen minutes pass.
    await pool.query(`UPDATE orders SET expires_at = now() - interval '1 second' WHERE id = $1`, [
      stale.body.order.id,
    ]);

    // The seat is free again.
    expect(
      (await placeOrder(fast.token, organizer.eventId, organizer.ticketTypeId, 1)).status,
    ).toBe(201);

    const late = await pay(slow.token, stale.body.order.id);
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('ORDER_EXPIRED');

    const after = await request(app)
      .get(`/api/orders/${stale.body.order.id}`)
      .set('Authorization', `Bearer ${slow.token}`);
    expect(after.body.order).toMatchObject({ status: 'cancelled', payment: null, tickets: [] });
  });

  it('refuses a simulated payment that claims to be real, in the database itself', async () => {
    const organizer = await organizerWithPaidEvent(1);
    const user = await register('Someone');

    await expect(
      pool.query(
        `INSERT INTO payments (purpose, event_id, paid_by, amount, method, is_demonstration)
         VALUES ('activation_fee', $1, $2, 500000, 'simulated', false)`,
        [organizer.eventId, user.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
