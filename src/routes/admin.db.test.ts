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

  // -------------------------------------------------------------------------
  // Users
  // -------------------------------------------------------------------------

  async function admin(): Promise<{ id: string; token: string }> {
    const user = await register('Platform admin');
    await pool.query(`UPDATE users SET role = 'platform_admin' WHERE id = $1`, [user.id]);
    return {
      id: user.id,
      token: signToken({ id: user.id, role: 'platform_admin' }),
    };
  }

  it('finds a user by email, suspends the login, and unsuspending restores it', async () => {
    const platformAdmin = await admin();
    const victim = await register('Suspended person');
    const victimEmail = (
      await pool.query<{ email: string }>('SELECT email FROM users WHERE id = $1', [victim.id])
    ).rows[0]!.email;

    const search = await request(app)
      .get(`/api/admin/users?q=${encodeURIComponent(victimEmail)}`)
      .set('Authorization', `Bearer ${platformAdmin.token}`);
    expect(search.status).toBe(200);
    expect(search.body.users).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: victim.id, email: victimEmail, suspended: false }),
      ]),
    );

    const suspended = await request(app)
      .post(`/api/admin/users/${victim.id}/suspend`)
      .set('Authorization', `Bearer ${platformAdmin.token}`);
    expect(suspended.status).toBe(200);
    expect(suspended.body.user).toMatchObject({
      id: victim.id,
      suspended: true,
      suspended_by: platformAdmin.id,
    });

    const refused = await request(app)
      .post('/api/auth/login')
      .send({ email: victimEmail, password: 'test-password' });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('ACCOUNT_SUSPENDED');

    const lifted = await request(app)
      .post(`/api/admin/users/${victim.id}/unsuspend`)
      .set('Authorization', `Bearer ${platformAdmin.token}`);
    expect(lifted.status).toBe(200);
    expect(lifted.body.user).toMatchObject({ suspended: false, suspended_at: null });

    const allowed = await request(app)
      .post('/api/auth/login')
      .send({ email: victimEmail, password: 'test-password' });
    expect(allowed.status).toBe(200);

    const audits = await pool.query<{ action: string; actor_id: string }>(
      `SELECT action, actor_id FROM audit_log
        WHERE entity_id = $1 AND action IN ('user.suspended', 'user.unsuspended')`,
      [victim.id],
    );
    expect(audits.rows.map((row) => row.action).sort()).toEqual([
      'user.suspended',
      'user.unsuspended',
    ]);
    expect(audits.rows.every((row) => row.actor_id === platformAdmin.id)).toBe(true);
  });

  it('refuses to suspend the admin themselves or another platform admin', async () => {
    const first = await admin();
    const second = await admin();

    const self = await request(app)
      .post(`/api/admin/users/${first.id}/suspend`)
      .set('Authorization', `Bearer ${first.token}`);
    expect(self.status).toBe(409);

    const other = await request(app)
      .post(`/api/admin/users/${second.id}/suspend`)
      .set('Authorization', `Bearer ${first.token}`);
    expect(other.status).toBe(409);
  });

  // -------------------------------------------------------------------------
  // Reports
  // -------------------------------------------------------------------------

  it('reports a published event, then a suspend action hides it and actions the report', async () => {
    const platformAdmin = await admin();
    const reporter = await register('Reporter');
    const { eventId } = await publishedEvent();

    const created = await request(app)
      .post(`/api/events/${eventId}/report`)
      .set('Authorization', `Bearer ${reporter.token}`)
      .send({ reason: 'The description looks like spam' });
    expect(created.status).toBe(201);
    const reportId = created.body.report.id as string;
    expect(created.body.report).toMatchObject({
      event: { id: eventId, suspended: false },
      status: 'open',
    });

    const duplicate = await request(app)
      .post(`/api/events/${eventId}/report`)
      .set('Authorization', `Bearer ${reporter.token}`)
      .send({ reason: 'Again' });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('CONFLICT');

    const open = await request(app)
      .get('/api/admin/reports?status=open')
      .set('Authorization', `Bearer ${platformAdmin.token}`);
    expect(open.status).toBe(200);
    expect(open.body.reports).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: reportId, status: 'open' })]),
    );

    const resolved = await request(app)
      .post(`/api/admin/reports/${reportId}/resolve`)
      .set('Authorization', `Bearer ${platformAdmin.token}`)
      .send({ action: 'suspend' });
    expect(resolved.status).toBe(200);
    expect(resolved.body.report).toMatchObject({ id: reportId, status: 'actioned' });

    expect(await listedIds()).not.toContain(eventId);
    const reports = await pool.query<{ status: string }>(
      `SELECT status FROM event_reports WHERE event_id = $1`,
      [eventId],
    );
    expect(reports.rows.map((row) => row.status)).toEqual(['actioned']);

    const audit = await pool.query<{ actor_id: string }>(
      `SELECT actor_id FROM audit_log
        WHERE event_id = $1 AND action = 'event.suspended'`,
      [eventId],
    );
    expect(audit.rows[0]?.actor_id).toBe(platformAdmin.id);
  });

  it('dismisses a report and records event_report.dismissed', async () => {
    const platformAdmin = await admin();
    const reporter = await register('Reporter');
    const { eventId } = await publishedEvent();
    const created = await request(app)
      .post(`/api/events/${eventId}/report`)
      .set('Authorization', `Bearer ${reporter.token}`)
      .send({ reason: 'Not really a problem' });
    expect(created.status).toBe(201);
    const reportId = created.body.report.id as string;

    const resolved = await request(app)
      .post(`/api/admin/reports/${reportId}/resolve`)
      .set('Authorization', `Bearer ${platformAdmin.token}`)
      .send({ action: 'dismiss' });
    expect(resolved.status).toBe(200);
    expect(resolved.body.report.status).toBe('dismissed');

    const audit = await pool.query<{ action: string; entity_type: string }>(
      `SELECT action, entity_type FROM audit_log WHERE entity_id = $1`,
      [reportId],
    );
    expect(audit.rows).toEqual([{ action: 'event_report.dismissed', entity_type: 'event_report' }]);
    expect(await listedIds()).toContain(eventId);
  });

  // -------------------------------------------------------------------------
  // Activation fee
  // -------------------------------------------------------------------------

  async function organizerWithPaidEvent(): Promise<{
    token: string;
    eventId: string;
    ticketTypeId: string;
  }> {
    const user = await register('Fee organizer');
    await pool.query('UPDATE users SET email_verified_at = now() WHERE id = $1', [user.id]);
    const profile = await request(app)
      .post('/api/me/organizer-profile')
      .set('Authorization', `Bearer ${user.token}`)
      .send({
        display_name: 'Fee organizer',
        contact_email: `${randomUUID()}@test.biletflow.kz`,
        payout: { bank_name: 'Demo Bank', iban: 'KZ000000000000000000', account_holder: 'Fee' },
      });
    expect(profile.status).toBe(201);
    const token = profile.body.token as string;

    const startsAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
    const created = await request(app)
      .post('/api/events')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: `Fee event ${randomUUID()}`,
        description: 'A paid event',
        venue_name: 'Test venue',
        venue_address: 'Test address',
        starts_at: startsAt.toISOString(),
        ends_at: new Date(startsAt.getTime() + 2 * 60 * 60 * 1000).toISOString(),
      });
    expect(created.status).toBe(201);
    const eventId = created.body.event.id as string;

    const ticketType = await request(app)
      .post(`/api/events/${eventId}/ticket-types`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Standard', price: 500000, quantity_total: 10 });
    expect(ticketType.status).toBe(201);
    const published = await request(app)
      .post(`/api/events/${eventId}/publish`)
      .set('Authorization', `Bearer ${token}`);
    expect(published.status).toBe(200);

    return {
      token,
      eventId,
      ticketTypeId: ticketType.body.ticket_type.id as string,
    };
  }

  it('changes the next activation fee and keeps an already-paid one', async () => {
    const platformAdmin = await admin();
    const first = await organizerWithPaidEvent();
    const second = await organizerWithPaidEvent();

    const before = await request(app)
      .get(`/api/events/${first.eventId}/paid-sales`)
      .set('Authorization', `Bearer ${first.token}`);
    expect(before.body.paid_sales.activation_fee.amount).toBe(500000);

    const paidBefore = await request(app)
      .post(`/api/events/${first.eventId}/paid-sales/activation-fee`)
      .set('Authorization', `Bearer ${first.token}`);
    expect(paidBefore.status).toBe(200);

    try {
      const changed = await request(app)
        .patch('/api/admin/settings')
        .set('Authorization', `Bearer ${platformAdmin.token}`)
        .send({ activation_fee: 750000 });
      expect(changed.status).toBe(200);
      expect(changed.body.settings).toMatchObject({ activation_fee: 750000, currency: 'KZT' });

      const after = await request(app)
        .get(`/api/events/${first.eventId}/paid-sales`)
        .set('Authorization', `Bearer ${first.token}`);
      expect(after.body.paid_sales.activation_fee).toMatchObject({
        amount: 750000,
        payment: { amount: 500000, method: 'simulated', is_demonstration: true },
      });

      const paidAfter = await request(app)
        .post(`/api/events/${second.eventId}/paid-sales/activation-fee`)
        .set('Authorization', `Bearer ${second.token}`);
      expect(paidAfter.status).toBe(200);
      expect(paidAfter.body.paid_sales.activation_fee.payment.amount).toBe(750000);

      const payments = await pool.query<{ amount: number }>(
        `SELECT amount FROM payments WHERE event_id = ANY($1::uuid[]) ORDER BY amount`,
        [[first.eventId, second.eventId]],
      );
      expect(payments.rows.map((row) => row.amount)).toEqual([500000, 750000]);

      const audit = await pool.query<{ actor_id: string }>(
        `SELECT actor_id FROM audit_log
          WHERE action = 'platform_settings.updated' AND actor_id = $1`,
        [platformAdmin.id],
      );
      expect(audit.rows.length).toBeGreaterThanOrEqual(1);
    } finally {
      // Put the platform-wide default back so other database tests see 5,000 KZT.
      await request(app)
        .patch('/api/admin/settings')
        .set('Authorization', `Bearer ${platformAdmin.token}`)
        .send({ activation_fee: 500000 });
    }
  });

  // -------------------------------------------------------------------------
  // CSV export
  // -------------------------------------------------------------------------

  it('exports a header and one row per order, with CSV quoting', async () => {
    const platformAdmin = await admin();
    const buyer = await register('CSV buyer');
    const buyerEmail = (
      await pool.query<{ email: string }>('SELECT email FROM users WHERE id = $1', [buyer.id])
    ).rows[0]!.email;
    // A comma and a quote in a field are exactly what the escaping has to handle.
    await pool.query(`UPDATE users SET name = $2 WHERE id = $1`, [buyer.id, 'Buyer, "CSV"']);

    const event = await publishedEvent();
    const first = await order(buyer.token, event.eventId, event.ticketTypeId);
    const second = await order(buyer.token, event.eventId, event.ticketTypeId);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    const csv = await request(app)
      .get(`/api/admin/export/orders.csv?q=${encodeURIComponent(buyerEmail)}`)
      .set('Authorization', `Bearer ${platformAdmin.token}`);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    const lines = (csv.text as string).split('\n');
    expect(lines[0]).toContain('order_id,status,buyer_name');
    expect(lines).toHaveLength(4); // header, two orders, and the trailing newline
    expect(lines[1]).toContain('"Buyer, ""CSV"""');
    expect((csv.text as string).split(first.body.order.id as string)).toHaveLength(2);
    expect((csv.text as string).split(second.body.order.id as string)).toHaveLength(2);
    expect(csv.text as string).toContain('0.00');
  });

  // -------------------------------------------------------------------------
  // Authorization on every admin endpoint
  // -------------------------------------------------------------------------

  it('answers 401 anonymously and 403 to a non-admin on every admin endpoint', async () => {
    const stranger = await register('Not an admin');
    const endpoints: [string, string, unknown?][] = [
      ['get', '/api/admin/users'],
      ['post', `/api/admin/users/${stranger.id}/suspend`],
      ['post', `/api/admin/users/${stranger.id}/unsuspend`],
      ['get', '/api/admin/events'],
      ['post', `/api/admin/events/33333333-3333-4333-8333-333333333333/suspend`],
      ['post', `/api/admin/events/33333333-3333-4333-8333-333333333333/unsuspend`],
      ['get', '/api/admin/reports'],
      [
        'post',
        '/api/admin/reports/44444444-4444-4444-8444-444444444444/resolve',
        { action: 'dismiss' },
      ],
      ['get', '/api/admin/settings'],
      ['patch', '/api/admin/settings', { activation_fee: 500000 }],
      ['get', '/api/admin/orders'],
      ['get', '/api/admin/export/orders.csv'],
      ['get', '/api/admin/export/refunds.csv'],
    ];

    for (const [method, path, body] of endpoints) {
      const anonymousCall = request(app)[method as 'get'](path);
      const anonymous =
        body === undefined ? await anonymousCall : await anonymousCall.send(body as object);
      expect(anonymous.status, `${method} ${path} without a token`).toBe(401);

      const forbiddenCall = request(app)
        [method as 'get'](path)
        .set('Authorization', `Bearer ${stranger.token}`);
      const forbidden =
        body === undefined ? await forbiddenCall : await forbiddenCall.send(body as object);
      expect(forbidden.status, `${method} ${path} as a non-admin`).toBe(403);
      expect(forbidden.body.error.code).toBe('FORBIDDEN');
    }
  });
});
