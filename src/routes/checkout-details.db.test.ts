/**
 * Checkout details against a real Postgres: named attendees, the processing charge,
 * payment audit entries and order confirmation email. Skipped without TEST_DATABASE_URL.
 */
import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)('checkout details against a real database', () => {
  let app: Express;
  let pool: Pool;
  let eventId: string;
  let paidTicketTypeId: string;
  let freeTicketTypeId: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.JWT_SECRET ??= 'test-jwt-secret';
    ({ pool } = await import('../db/pool'));
    const { createApp } = await import('../app');
    app = createApp();

    const organizer = await register('Checkout Organizer');
    await pool.query('UPDATE users SET email_verified_at = now() WHERE id = $1', [organizer.id]);
    const profile = await request(app)
      .post('/api/me/organizer-profile')
      .set('Authorization', `Bearer ${organizer.token}`)
      .send({
        display_name: 'Checkout Test Organizer',
        contact_email: 'organizer@test.biletflow.kz',
        payout: { bank_name: 'Demo Bank', iban: 'KZ000000000000000000', account_holder: 'Test' },
      });
    expect(profile.status).toBe(201);
    const organizerToken = profile.body.token as string;

    const event = await pool.query<{ id: string }>(
      `INSERT INTO events (organizer_id, title, venue_name, venue_address, starts_at, ends_at, status)
       VALUES ($1, 'Checkout test event', 'Test venue', 'Test address',
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

    const freeType = await request(app)
      .post(`/api/events/${eventId}/ticket-types`)
      .set('Authorization', `Bearer ${organizerToken}`)
      .send({ name: 'Free admission', price: 0, quantity_total: 10 });
    expect(freeType.status).toBe(201);
    freeTicketTypeId = freeType.body.ticket_type.id;

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

  function placeOrder(token: string, ticketTypeId: string, attendeeNames?: string[]) {
    return request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({
        event_id: eventId,
        items: [
          {
            ticket_type_id: ticketTypeId,
            quantity: attendeeNames?.length ?? 1,
            ...(attendeeNames && { attendee_names: attendeeNames }),
          },
        ],
      });
  }

  function pay(token: string, orderId: string) {
    return request(app).post(`/api/orders/${orderId}/pay`).set('Authorization', `Bearer ${token}`);
  }

  it('charges 3%, names both tickets, sends their codes and audits the payment', async () => {
    const buyer = await register('Paid Buyer');
    const placed = await placeOrder(buyer.token, paidTicketTypeId, ['Aru', 'Bek']);
    expect(placed.status).toBe(201);
    expect(placed.body.order).toMatchObject({
      subtotal: 1000000,
      discount: 0,
      processing_fee: 30000,
      total: 1030000,
    });
    const orderId = placed.body.order.id as string;

    const paid = await pay(buyer.token, orderId);
    expect(paid.status).toBe(200);
    expect(paid.body.order.payment.amount).toBe(1030000);
    const tickets = paid.body.order.tickets as { code: string; attendee_name: string }[];
    expect(tickets).toHaveLength(2);
    expect(tickets.map((ticket) => ticket.attendee_name).sort()).toEqual(['Aru', 'Bek']);

    const inbox = await request(app)
      .get('/api/me/emails')
      .set('Authorization', `Bearer ${buyer.token}`);
    expect(inbox.status).toBe(200);
    const confirmations = (
      inbox.body.emails as { kind: string; subject: string; body: string }[]
    ).filter((email) => email.kind === 'order_confirmation');
    expect(confirmations).toHaveLength(1);
    expect(confirmations[0]!.subject).toBe('Your tickets for Checkout test event');
    for (const ticket of tickets) {
      expect(confirmations[0]!.body).toContain(`${ticket.code}  Standard  ${ticket.attendee_name}`);
    }
    expect(confirmations[0]!.body).toContain('See them with their QR codes:');
    expect(confirmations[0]!.body).toContain(
      'Simulated payment: 10300.00 KZT. No real money was charged.',
    );

    const audits = await pool.query<{
      actor_id: string;
      event_id: string;
      description: string;
    }>(
      `SELECT actor_id, event_id, description FROM audit_log
        WHERE action = 'order.paid' AND entity_type = 'order' AND entity_id = $1`,
      [orderId],
    );
    expect(audits.rows).toEqual([
      {
        actor_id: buyer.id,
        event_id: eventId,
        description: 'Paid 2 tickets, 10300.00 KZT (simulated)',
      },
    ]);
  });

  it('defaults a free ticket to the buyer name and audits the free registration', async () => {
    const buyer = await register('Free Buyer');
    const placed = await placeOrder(buyer.token, freeTicketTypeId);
    expect(placed.status).toBe(201);
    expect(placed.body.order).toMatchObject({ processing_fee: 0, total: 0 });
    const orderId = placed.body.order.id as string;

    const paid = await pay(buyer.token, orderId);
    expect(paid.status).toBe(200);
    expect(paid.body.order.tickets).toHaveLength(1);
    expect(paid.body.order.tickets[0].attendee_name).toBe('Free Buyer');

    const audits = await pool.query<{ description: string }>(
      `SELECT description FROM audit_log
        WHERE action = 'order.paid' AND entity_type = 'order' AND entity_id = $1`,
      [orderId],
    );
    expect(audits.rows).toEqual([{ description: 'Registered 1 free tickets' }]);
  });
});
