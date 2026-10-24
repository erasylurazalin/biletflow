import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)(
  'event publishing and cancellation against a real database',
  () => {
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

    async function register(name: string): Promise<{ id: string; token: string }> {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ email: `${randomUUID()}@test.biletflow.kz`, password: 'test-password', name });
      expect(res.status).toBe(201);
      return { id: res.body.user.id, token: res.body.token };
    }

    it('publishes, sells a ticket, then cancels the event and ticket with audit entries', async () => {
      const organizer = await register('Organizer');
      const profile = await request(app)
        .post('/api/me/organizer-profile')
        .set('Authorization', `Bearer ${organizer.token}`)
        .send({
          display_name: 'Test Organizer',
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
          title: 'Publish and cancel test event',
          description: 'A real database test event',
          venue_name: 'Test venue',
          venue_address: 'Test address',
          starts_at: startsAt.toISOString(),
          ends_at: endsAt.toISOString(),
        });
      expect(created.status).toBe(201);
      expect(created.body.event.status).toBe('draft');
      const eventId = created.body.event.id as string;

      const ticketType = await request(app)
        .post(`/api/events/${eventId}/ticket-types`)
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({ name: 'Free admission', price: 0, quantity_total: 10 });
      expect(ticketType.status).toBe(201);
      const ticketTypeId = ticketType.body.ticket_type.id as string;

      const published = await request(app)
        .post(`/api/events/${eventId}/publish`)
        .set('Authorization', `Bearer ${organizerToken}`);
      expect(published.status).toBe(200);
      expect(published.body.event.status).toBe('published');

      const list = await request(app).get('/api/events?limit=100');
      expect(list.status).toBe(200);
      expect(list.body.events).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: eventId })]),
      );

      const buyer = await register('Buyer');
      const placed = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${buyer.token}`)
        .send({ event_id: eventId, items: [{ ticket_type_id: ticketTypeId, quantity: 1 }] });
      expect(placed.status).toBe(201);
      const paid = await request(app)
        .post(`/api/orders/${placed.body.order.id}/pay`)
        .set('Authorization', `Bearer ${buyer.token}`);
      expect(paid.status).toBe(200);
      expect(paid.body.order.tickets).toHaveLength(1);
      const ticketId = paid.body.order.tickets[0].id as string;

      const cancelled = await request(app)
        .post(`/api/events/${eventId}/cancel`)
        .set('Authorization', `Bearer ${organizerToken}`);
      expect(cancelled.status).toBe(200);
      expect(cancelled.body.event.status).toBe('cancelled');

      const ticket = await request(app)
        .get(`/api/tickets/${ticketId}`)
        .set('Authorization', `Bearer ${buyer.token}`);
      expect(ticket.status).toBe(200);
      expect(ticket.body.ticket.status).toBe('cancelled');

      const audits = await pool.query<{ action: string }>(
        `SELECT action FROM audit_log
        WHERE event_id = $1 AND action IN ('event.published', 'event.cancelled')`,
        [eventId],
      );
      expect(audits.rows).toHaveLength(2);
      expect(audits.rows).toEqual(
        expect.arrayContaining([{ action: 'event.published' }, { action: 'event.cancelled' }]),
      );
    });
  },
);
