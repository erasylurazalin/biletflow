/**
 * Support cases against a real Postgres, end to end through the API: an attendee opens
 * a case from a ticket, the organizer and event staff reply, the attendee sees the
 * thread and the email, responders change status and assignment, and strangers get
 * 404. Platform cases go to platform admins only.
 *
 * Runs only when TEST_DATABASE_URL is set. Setup is in orders.db.test.ts.
 */
import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const PASSWORD = 'test-password';

describe.skipIf(!TEST_DATABASE_URL)('support cases against a real database', () => {
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

  interface Account {
    id: string;
    email: string;
    name: string;
    token: string;
  }

  async function register(name: string): Promise<Account> {
    const email = `support-${randomUUID()}@test.biletflow.kz`;
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email, password: PASSWORD, name });
    expect(res.status).toBe(201);
    return { id: res.body.user.id, email, name, token: res.body.token };
  }

  async function login(email: string): Promise<string> {
    const res = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
    expect(res.status).toBe(200);
    return res.body.token;
  }

  async function makeOrganizer(name: string): Promise<Account> {
    const account = await register(name);
    await pool.query('UPDATE users SET email_verified_at = now() WHERE id = $1', [account.id]);
    const res = await request(app)
      .post('/api/me/organizer-profile')
      .set('Authorization', `Bearer ${account.token}`)
      .send({
        display_name: name,
        contact_email: `${randomUUID()}@organizer.test.biletflow.kz`,
      });
    expect(res.status).toBe(201);
    return { ...account, token: res.body.token };
  }

  async function makePlatformAdmin(name: string): Promise<Account> {
    const account = await register(name);
    await pool.query(`UPDATE users SET role = 'platform_admin' WHERE id = $1`, [account.id]);
    return { ...account, token: await login(account.email) };
  }

  async function makeEvent(organizerId: string): Promise<string> {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO events (organizer_id, title, venue_name, venue_address, starts_at, ends_at, status)
       VALUES ($1, $2, 'Support venue', 'Support address',
               now() + interval '7 days', now() + interval '7 days 2 hours', 'published')
       RETURNING id`,
      [organizerId, `Support test event ${randomUUID()}`],
    );
    return result.rows[0]!.id;
  }

  async function addPaidTicket(userId: string, eventId: string) {
    const ticketType = await pool.query<{ id: string }>(
      `INSERT INTO ticket_types (event_id, name, price, quantity_total)
       VALUES ($1, 'Standard', 500000, 100)
       RETURNING id`,
      [eventId],
    );
    const order = await pool.query<{ id: string }>(
      `INSERT INTO orders (user_id, event_id, status, subtotal, discount, total, processing_fee)
       VALUES ($1, $2, 'paid', 500000, 0, 515000, 15000)
       RETURNING id`,
      [userId, eventId],
    );
    const orderItem = await pool.query<{ id: string }>(
      `INSERT INTO order_items (order_id, ticket_type_id, name, quantity, unit_price)
       VALUES ($1, $2, 'Standard', 1, 500000)
       RETURNING id`,
      [order.rows[0]!.id, ticketType.rows[0]!.id],
    );
    const code = `BF-${randomUUID().slice(0, 8).toUpperCase()}`;
    const ticket = await pool.query<{ id: string }>(
      `INSERT INTO tickets (order_item_id, event_id, ticket_type_id, code, attendee_name)
       VALUES ($1, $2, $3, $4, 'Attendee')
       RETURNING id`,
      [orderItem.rows[0]!.id, eventId, ticketType.rows[0]!.id, code],
    );
    return { orderId: order.rows[0]!.id, ticketId: ticket.rows[0]!.id, code };
  }

  function openEventCase(
    token: string,
    eventId: string,
    context: { order_id?: string; ticket_id?: string } = {},
  ) {
    return request(app)
      .post('/api/support/cases')
      .set('Authorization', `Bearer ${token}`)
      .send({
        kind: 'event',
        event_id: eventId,
        ...context,
        category: 'ticket_delivery',
        subject: 'My ticket did not arrive',
        body: 'I paid for the ticket but I cannot find it in my account.',
      });
  }

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  it('runs the attendee, organizer, staff, platform and access-control flow', async () => {
    const organizer = await makeOrganizer('Organizer One');
    const otherOrganizer = await makeOrganizer('Organizer Two');
    const attendee = await register('Aidos Attendee');
    const staff = await register('Door Staff');
    const stranger = await register('Nosy Stranger');
    const platformAdmin = await makePlatformAdmin('Platform Admin');

    const eventId = await makeEvent(organizer.id);
    const otherEventId = await makeEvent(otherOrganizer.id);
    const ownContext = await addPaidTicket(attendee.id, eventId);
    const staffContext = await addPaidTicket(staff.id, eventId);
    await addPaidTicket(attendee.id, otherEventId);
    await pool.query(
      `INSERT INTO event_staff (event_id, user_id, assigned_by) VALUES ($1, $2, $3)`,
      [eventId, staff.id, organizer.id],
    );

    // The attendee opens from the ticket page: event, order and ticket context.
    const opened = await openEventCase(attendee.token, eventId, {
      order_id: ownContext.orderId,
      ticket_id: ownContext.ticketId,
    });
    expect(opened.status).toBe(201);
    const caseId = opened.body.case.id as string;
    expect(opened.body.case).toMatchObject({
      kind: 'event',
      event_id: eventId,
      order_id: ownContext.orderId,
      ticket_id: ownContext.ticketId,
      opened_by: attendee.id,
      status: 'open',
      assigned_to: null,
      role: 'opener',
    });
    expect(opened.body.case.event_title).toContain('Support test event');

    const firstRead = await request(app)
      .get(`/api/support/cases/${caseId}`)
      .set(auth(attendee.token));
    expect(firstRead.status).toBe(200);
    expect(firstRead.body.messages).toHaveLength(1);
    expect(firstRead.body.messages[0]).toMatchObject({
      author_id: attendee.id,
      author_name: 'Aidos Attendee',
      is_responder: false,
    });
    expect(firstRead.body.messages[0].body).toContain('I paid for the ticket');

    // The organizer sees it on the responder side and in the list.
    const organizerList = await request(app)
      .get('/api/support/cases?limit=100')
      .set(auth(organizer.token));
    expect(organizerList.status).toBe(200);
    const listed = organizerList.body.cases.find((item: { id: string }) => item.id === caseId);
    expect(listed).toMatchObject({ role: 'responder', event_title: opened.body.case.event_title });
    expect(listed.last_message_at).toBeTruthy();

    const organizerDetail = await request(app)
      .get(`/api/support/cases/${caseId}`)
      .set(auth(organizer.token));
    expect(organizerDetail.status).toBe(200);
    expect(organizerDetail.body.case.responders.map((r: { id: string }) => r.id)).toEqual(
      expect.arrayContaining([organizer.id, staff.id]),
    );

    const organizerReply = await request(app)
      .post(`/api/support/cases/${caseId}/messages`)
      .set(auth(organizer.token))
      .send({ body: 'Your ticket is in My tickets. I can see the order on my side.' });
    expect(organizerReply.status).toBe(201);
    expect(organizerReply.body.message).toMatchObject({
      author_id: organizer.id,
      is_responder: true,
      author_name: 'Organizer One',
    });

    // Event staff, not only the organizer, can reply.
    const staffReply = await request(app)
      .post(`/api/support/cases/${caseId}/messages`)
      .set(auth(staff.token))
      .send({ body: 'I also checked the door list, the ticket is valid.' });
    expect(staffReply.status).toBe(201);
    expect(staffReply.body.message.is_responder).toBe(true);

    const attendeeRead = await request(app)
      .get(`/api/support/cases/${caseId}`)
      .set(auth(attendee.token));
    expect(attendeeRead.status).toBe(200);
    expect(attendeeRead.body.messages).toHaveLength(3);
    expect(attendeeRead.body.messages[1].body).toContain('Your ticket is in My tickets');
    expect(attendeeRead.body.messages[2].body).toContain('door list');

    const attendeeEmail = await pool.query<{ subject: string; body: string }>(
      `SELECT subject, body FROM email_outbox
        WHERE user_id = $1 AND kind = 'support_reply'
        ORDER BY created_at DESC LIMIT 1`,
      [attendee.id],
    );
    expect(attendeeEmail.rows[0]?.subject).toBe('New reply to your support case');
    expect(attendeeEmail.rows[0]?.body).toContain(`/support/${caseId}`);

    // The opener cannot change status; a stranger and another organizer see nothing.
    const openerPatch = await request(app)
      .patch(`/api/support/cases/${caseId}`)
      .set(auth(attendee.token))
      .send({ status: 'resolved' });
    expect(openerPatch.status).toBe(403);
    expect(openerPatch.body.error.code).toBe('FORBIDDEN');

    for (const token of [stranger.token, otherOrganizer.token]) {
      const read = await request(app).get(`/api/support/cases/${caseId}`).set(auth(token));
      expect(read.status).toBe(404);
      expect(read.body.error.code).toBe('SUPPORT_CASE_NOT_FOUND');

      const reply = await request(app)
        .post(`/api/support/cases/${caseId}/messages`)
        .set(auth(token))
        .send({ body: 'Let me in' });
      expect(reply.status).toBe(404);
      expect(reply.body.error.code).toBe('SUPPORT_CASE_NOT_FOUND');

      const patch = await request(app)
        .patch(`/api/support/cases/${caseId}`)
        .set(auth(token))
        .send({ status: 'resolved' });
      expect(patch.status).toBe(404);
      expect(patch.body.error.code).toBe('SUPPORT_CASE_NOT_FOUND');
    }

    // A non-responder cannot be assigned.
    const badAssignment = await request(app)
      .patch(`/api/support/cases/${caseId}`)
      .set(auth(organizer.token))
      .send({ assigned_to: stranger.id });
    expect(badAssignment.status).toBe(400);
    expect(badAssignment.body.error.code).toBe('VALIDATION_ERROR');

    // Status and assignment together, by a responder.
    const patched = await request(app)
      .patch(`/api/support/cases/${caseId}`)
      .set(auth(organizer.token))
      .send({ status: 'waiting_for_customer', assigned_to: staff.id });
    expect(patched.status).toBe(200);
    expect(patched.body.case).toMatchObject({
      status: 'waiting_for_customer',
      assigned_to: staff.id,
      assigned_to_name: 'Door Staff',
    });

    const audits = await pool.query<{
      action: string;
      entity_type: string;
      event_id: string | null;
    }>(
      `SELECT action, entity_type, event_id FROM audit_log
        WHERE entity_id = $1 ORDER BY created_at, id`,
      [caseId],
    );
    expect(audits.rows).toEqual(
      expect.arrayContaining([
        { action: 'support_case.opened', entity_type: 'support_case', event_id: eventId },
        { action: 'support_case.status_changed', entity_type: 'support_case', event_id: eventId },
        { action: 'support_case.assigned', entity_type: 'support_case', event_id: eventId },
      ]),
    );

    const statusEmail = await pool.query<{ body: string }>(
      `SELECT body FROM email_outbox
        WHERE user_id = $1 AND kind = 'support_status_changed'
        ORDER BY created_at DESC LIMIT 1`,
      [attendee.id],
    );
    expect(statusEmail.rows[0]?.body).toContain('/support/');

    // A ticket of another user is not valid context for this attendee.
    const foreignTicket = await openEventCase(attendee.token, eventId, {
      ticket_id: staffContext.ticketId,
    });
    expect(foreignTicket.status).toBe(404);
    expect(foreignTicket.body.error.code).toBe('TICKET_NOT_FOUND');

    // Platform cases: the organizer opens one, a platform admin sees it, another
    // organizer does not.
    const platformCase = await request(app)
      .post('/api/support/cases')
      .set(auth(otherOrganizer.token))
      .send({
        kind: 'platform',
        category: 'account',
        subject: 'I cannot activate paid sales',
        body: 'The activation fee page keeps saying incomplete.',
      });
    expect(platformCase.status).toBe(201);
    const platformCaseId = platformCase.body.case.id as string;
    expect(platformCase.body.case).toMatchObject({
      kind: 'platform',
      event_id: null,
      order_id: null,
      ticket_id: null,
      status: 'open',
      role: 'opener',
    });

    const adminRead = await request(app)
      .get(`/api/support/cases/${platformCaseId}`)
      .set(auth(platformAdmin.token));
    expect(adminRead.status).toBe(200);
    expect(adminRead.body.case.role).toBe('responder');
    expect(adminRead.body.case.responders.map((r: { id: string }) => r.id)).toContain(
      platformAdmin.id,
    );

    const adminReply = await request(app)
      .post(`/api/support/cases/${platformCaseId}/messages`)
      .set(auth(platformAdmin.token))
      .send({ body: 'I can see the profile, please try the fee step again.' });
    expect(adminReply.status).toBe(201);

    const outsiderRead = await request(app)
      .get(`/api/support/cases/${platformCaseId}`)
      .set(auth(organizer.token));
    expect(outsiderRead.status).toBe(404);
    expect(outsiderRead.body.error.code).toBe('SUPPORT_CASE_NOT_FOUND');
  });
});
