/**
 * Simulated payment failure against a real Postgres, including the committed audit and
 * email and a successful retry. Skipped without TEST_DATABASE_URL.
 */
import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)('payment failure against a real database', () => {
  let app: Express;
  let pool: Pool;
  let eventId: string;
  let paidTicketTypeId: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.JWT_SECRET ??= 'test-jwt-secret';
    ({ pool } = await import('../db/pool'));
    const { createApp } = await import('../app');
    app = createApp();

    const organizer = await register('Payment Failure Organizer');
    await pool.query('UPDATE users SET email_verified_at = now() WHERE id = $1', [organizer.id]);
    const profile = await request(app)
      .post('/api/me/organizer-profile')
      .set('Authorization', `Bearer ${organizer.token}`)
      .send({
        display_name: 'Payment Failure Test Organizer',
        contact_email: 'organizer@test.biletflow.kz',
        payout: { bank_name: 'Demo Bank', iban: 'KZ000000000000000000', account_holder: 'Test' },
      });
    expect(profile.status).toBe(201);
    const organizerToken = profile.body.token as string;

    const event = await pool.query<{ id: string }>(
      `INSERT INTO events (organizer_id, title, venue_name, venue_address, starts_at, ends_at, status)
       VALUES ($1, 'Payment failure test event', 'Test venue', 'Test address',
               now() + interval '7 days', now() + interval '7 days 2 hours', 'published')
       RETURNING id`,
      [organizer.id],
    );
    eventId = event.rows[0]!.id;

    const paidType = await request(app)
      .post(`/api/events/${eventId}/ticket-types`)
      .set('Authorization', `Bearer ${organizerToken}`)
      .send({ name: 'Standard', price: 500000, quantity_total: 10 });
    expect(paidType.status).toBe(201);
    paidTicketTypeId = paidType.body.ticket_type.id;

    const auth = { Authorization: `Bearer ${organizerToken}` };
    const base = `/api/events/${eventId}/paid-sales`;
    await request(app).post('/api/me/organizer-profile/verify-identity').set(auth).expect(200);
    await request(app).post(`${base}/activation-fee`).set(auth).expect(200);
    await request(app).post(`${base}/terms`).set(auth).send({ accepted: true }).expect(200);
    await request(app).post(`${base}/activate`).set(auth).expect(200);
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

  function pay(token: string, orderId: string, simulateFailure = false) {
    return request(app)
      .post(`/api/orders/${orderId}/pay`)
      .set('Authorization', `Bearer ${token}`)
      .send({ simulate_failure: simulateFailure });
  }

  it('keeps the order unpaid, commits the failure notice and allows a successful retry', async () => {
    const buyer = await register('Payment Failure Buyer');
    const placed = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${buyer.token}`)
      .send({
        event_id: eventId,
        items: [{ ticket_type_id: paidTicketTypeId, quantity: 1 }],
      });
    expect(placed.status).toBe(201);
    const orderId = placed.body.order.id as string;

    const failed = await pay(buyer.token, orderId, true);
    expect(failed.status).toBe(402);
    expect(failed.body.error.code).toBe('PAYMENT_FAILED');

    const pending = await request(app)
      .get(`/api/orders/${orderId}`)
      .set('Authorization', `Bearer ${buyer.token}`);
    expect(pending.status).toBe(200);
    expect(pending.body.order.status).toBe('pending');
    expect(pending.body.order.payment).toBeNull();
    expect(pending.body.order.tickets).toEqual([]);

    const payments = await pool.query('SELECT id FROM payments WHERE order_id = $1', [orderId]);
    expect(payments.rows).toEqual([]);
    const audits = await pool.query<{ description: string }>(
      `SELECT description FROM audit_log
        WHERE action = 'order.payment_failed' AND entity_type = 'order' AND entity_id = $1`,
      [orderId],
    );
    expect(audits.rows).toEqual([{ description: 'Simulated payment of 5150.00 KZT failed' }]);

    const inbox = await request(app)
      .get('/api/me/emails')
      .set('Authorization', `Bearer ${buyer.token}`);
    const failures = (
      inbox.body.emails as { kind: string; subject: string; body: string }[]
    ).filter((email) => email.kind === 'payment_failed');
    expect(failures).toHaveLength(1);
    expect(failures[0]!.subject).toBe('Your BiletFlow payment did not go through');
    expect(failures[0]!.body).toContain(
      'The simulated payment for Payment failure test event failed',
    );
    expect(failures[0]!.body).toContain('No money was taken');
    expect(failures[0]!.body).toContain(
      `Your seats stay reserved until ${pending.body.order.expires_at}`,
    );
    expect(failures[0]!.body).toContain(`http://localhost:3001/orders/${orderId}`);

    const paid = await pay(buyer.token, orderId);
    expect(paid.status).toBe(200);
    expect(paid.body.order.status).toBe('paid');
    expect(paid.body.order.tickets).toHaveLength(1);
    expect(paid.body.order.payment.amount).toBe(515000);
  });
});
