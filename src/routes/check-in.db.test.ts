import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

interface IssuedTicket {
  id: string;
  qr_payload: string;
}

describe.skipIf(!TEST_DATABASE_URL)('check-in against a real database', () => {
  let app: Express;
  let pool: Pool;
  let eventId: string;
  let staffToken: string;
  let unassignedToken: string;
  let tickets: IssuedTicket[];

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.JWT_SECRET ??= 'test-jwt-secret';
    ({ pool } = await import('../db/pool'));
    const { createApp } = await import('../app');
    app = createApp();

    async function register(name: string): Promise<{ id: string; email: string; token: string }> {
      const email = `${randomUUID()}@test.biletflow.kz`;
      const res = await request(app)
        .post('/api/auth/register')
        .send({ email, password: 'test-password', name });
      expect(res.status).toBe(201);
      return { id: res.body.user.id, email, token: res.body.token };
    }

    const organizer = await register('Check-in Organizer');
    const profile = await request(app)
      .post('/api/me/organizer-profile')
      .set('Authorization', `Bearer ${organizer.token}`)
      .send({
        display_name: 'Check-in Test Organizer',
        contact_email: `${randomUUID()}@test.biletflow.kz`,
      });
    expect(profile.status).toBe(201);
    const organizerToken = profile.body.token as string;

    const startsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const endsAt = new Date(startsAt.getTime() + 2 * 60 * 60 * 1000);
    const created = await request(app)
      .post('/api/events')
      .set('Authorization', `Bearer ${organizerToken}`)
      .send({
        title: 'Check-in test event',
        description: 'A real database check-in test event',
        venue_name: 'Test venue',
        venue_address: 'Test address',
        starts_at: startsAt.toISOString(),
        ends_at: endsAt.toISOString(),
      });
    expect(created.status).toBe(201);
    eventId = created.body.event.id as string;

    const ticketType = await request(app)
      .post(`/api/events/${eventId}/ticket-types`)
      .set('Authorization', `Bearer ${organizerToken}`)
      .send({ name: 'Free admission', price: 0, quantity_total: 2 });
    expect(ticketType.status).toBe(201);

    const published = await request(app)
      .post(`/api/events/${eventId}/publish`)
      .set('Authorization', `Bearer ${organizerToken}`);
    expect(published.status).toBe(200);

    const buyer = await register('Database Buyer');
    const placed = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${buyer.token}`)
      .send({
        event_id: eventId,
        items: [{ ticket_type_id: ticketType.body.ticket_type.id, quantity: 2 }],
      });
    expect(placed.status).toBe(201);
    const paid = await request(app)
      .post(`/api/orders/${placed.body.order.id}/pay`)
      .set('Authorization', `Bearer ${buyer.token}`);
    expect(paid.status).toBe(200);
    tickets = paid.body.order.tickets as IssuedTicket[];
    expect(tickets).toHaveLength(2);

    const staff = await register('Door Staff');
    staffToken = staff.token;
    const assigned = await request(app)
      .post(`/api/events/${eventId}/staff`)
      .set('Authorization', `Bearer ${organizerToken}`)
      .send({ email: staff.email });
    expect(assigned.status).toBe(201);

    const unassigned = await register('Unassigned User');
    unassignedToken = unassigned.token;
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('supports scans, undo, concurrent scans, attendee search and audit entries', async () => {
    const first = tickets[0]!;
    const second = tickets[1]!;

    const scan = (ticket: IssuedTicket, token = staffToken) =>
      request(app)
        .post('/api/staff/check-in')
        .set('Authorization', `Bearer ${token}`)
        .send({ event_id: eventId, qr_payload: ticket.qr_payload });

    const valid = await scan(first);
    expect(valid.status).toBe(200);
    expect(valid.body.result).toBe('valid');
    expect(valid.body.ticket).toMatchObject({ id: first.id, status: 'checked_in' });

    const alreadyUsed = await scan(first);
    expect(alreadyUsed.status).toBe(200);
    expect(alreadyUsed.body.result).toBe('already_used');
    expect(alreadyUsed.body.checked_in_at).toBe(valid.body.ticket.checked_in_at);

    const undone = await request(app)
      .post(`/api/staff/check-in/${first.id}/undo`)
      .set('Authorization', `Bearer ${staffToken}`);
    expect(undone.status).toBe(200);
    expect(undone.body.ticket).toMatchObject({
      id: first.id,
      status: 'valid',
      checked_in_at: null,
    });

    const validAgain = await scan(first);
    expect(validAgain.status).toBe(200);
    expect(validAgain.body.result).toBe('valid');

    const forbidden = await scan(second, unassignedToken);
    expect(forbidden.status).toBe(403);

    const concurrent = await Promise.all([scan(second), scan(second)]);
    expect(concurrent.map((res) => res.status)).toEqual([200, 200]);
    expect(concurrent.map((res) => res.body.result).sort()).toEqual(['already_used', 'valid']);

    const attendees = await request(app)
      .get(`/api/staff/events/${eventId}/attendees?q=${encodeURIComponent('Database Buyer')}`)
      .set('Authorization', `Bearer ${staffToken}`);
    expect(attendees.status).toBe(200);
    expect(attendees.body.attendees).toHaveLength(2);
    expect(attendees.body.attendees).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: first.id, attendee_name: 'Database Buyer' }),
        expect.objectContaining({ id: second.id, attendee_name: 'Database Buyer' }),
      ]),
    );
    expect(attendees.body.counts).toEqual({ registered: 2, checked_in: 2 });

    const audits = await pool.query<{ action: string; entity_id: string }>(
      `SELECT action, entity_id FROM audit_log
       WHERE event_id = $1
         AND action IN ('ticket.checked_in', 'ticket.check_in_reversed')`,
      [eventId],
    );
    // The first ticket is checked in twice (before and after the undo), the second once.
    expect(audits.rows).toHaveLength(4);
    expect(audits.rows.filter((row) => row.action === 'ticket.checked_in')).toHaveLength(3);
    expect(audits.rows).toContainEqual({ action: 'ticket.check_in_reversed', entity_id: first.id });
  });
});
