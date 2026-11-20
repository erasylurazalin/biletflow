/**
 * Analytics against a real Postgres: capacity, sales, revenue, attendance, day buckets
 * and the ticket type filter. Every number is worked out by hand below and then made
 * true through the ordinary endpoints, so a broken query shows up as a wrong figure
 * rather than as a fixture argument. Setup follows refunds.db.test.ts.
 *
 * The fixture:
 *
 *   Early Bird  5000 ₸ x 10 seats      VIP  10000 ₸ x 5 seats      Free  0 ₸ x 100
 *   capacity 115
 *
 *   A  Early Bird x2, paid                      subtotal 1000000, fee 30000
 *   B  VIP x1, paid then refunded               subtotal 1000000, fee 30000, refunded 1000000
 *   C  Free x3, paid                            subtotal 0
 *   D  Early Bird x1 with the SPRING20 campaign subtotal 500000, discount 100000, fee 12000
 *   E  Early Bird x1, left pending              holds 1 seat
 *
 *   sold    = A2 + C3 + D1 = 6 (B is refunded, E is not paid)
 *   held    = E1 = 1
 *   gross   = 1000000 + 1000000 + 0 + 500000 = 2500000
 *   discounts = 100000, refunds = 1000000, net = 1400000
 *   attendance = C3 + D1 + A2 = 6 registered, 0 checked in, until A1 is scanned
 *   the day  = 4 orders, 7 tickets, net 2400000
 *   campaign = 1 redemption, 1 order, 1 ticket, 500000 gross, 400000 net
 */
import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)('analytics against a real database', () => {
  let app: Express;
  let pool: Pool;
  let eventId: string;
  let earlyBirdId: string;
  let vipId: string;
  let freeId: string;
  let campaignId: string;
  let campaignCode: string;
  let organizerToken: string;
  let buyerToken: string;
  let staffToken: string;
  let earlyTicketQr: string;
  const orders: Record<'a' | 'b' | 'c' | 'd' | 'e', string> = {
    a: '',
    b: '',
    c: '',
    d: '',
    e: '',
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.JWT_SECRET ??= 'test-jwt-secret';
    ({ pool } = await import('../db/pool'));
    const { createApp } = await import('../app');
    app = createApp();

    // An organizer with a verified identity and a payout account, a published event
    // with paid sales active, and three ticket types.
    const organizer = await register('Analytics Organizer');
    await pool.query('UPDATE users SET email_verified_at = now() WHERE id = $1', [organizer.id]);
    const profile = await request(app)
      .post('/api/me/organizer-profile')
      .set('Authorization', `Bearer ${organizer.token}`)
      .send({
        display_name: 'Analytics Test Organizer',
        contact_email: 'analytics@test.biletflow.kz',
        payout: { bank_name: 'Demo Bank', iban: 'KZ000000000000000000', account_holder: 'Test' },
      });
    expect(profile.status).toBe(201);
    organizerToken = profile.body.token as string;
    const auth = { Authorization: `Bearer ${organizerToken}` };

    const event = await pool.query<{ id: string }>(
      `INSERT INTO events (organizer_id, title, venue_name, venue_address, starts_at, ends_at, status)
       VALUES ($1, 'Analytics test event', 'Test venue', 'Test address',
               now() + interval '7 days', now() + interval '7 days 2 hours', 'published')
       RETURNING id`,
      [organizer.id],
    );
    eventId = event.rows[0]!.id;

    const earlyBird = await request(app)
      .post(`/api/events/${eventId}/ticket-types`)
      .set(auth)
      .send({ name: 'Early Bird', price: 500000, quantity_total: 10 });
    expect(earlyBird.status).toBe(201);
    earlyBirdId = earlyBird.body.ticket_type.id;

    const vip = await request(app)
      .post(`/api/events/${eventId}/ticket-types`)
      .set(auth)
      .send({ name: 'VIP', price: 1000000, quantity_total: 5 });
    expect(vip.status).toBe(201);
    vipId = vip.body.ticket_type.id;

    const free = await request(app)
      .post(`/api/events/${eventId}/ticket-types`)
      .set(auth)
      .send({ name: 'Free', price: 0, quantity_total: 100 });
    expect(free.status).toBe(201);
    freeId = free.body.ticket_type.id;

    const base = `/api/events/${eventId}/paid-sales`;
    await request(app).post('/api/me/organizer-profile/verify-identity').set(auth).expect(200);
    await request(app).post(`${base}/activation-fee`).set(auth).expect(200);
    await request(app).post(`${base}/terms`).set(auth).send({ accepted: true }).expect(200);
    await request(app).post(`${base}/activate`).set(auth).expect(200);

    // The promo code is unique across the platform, so it carries a random suffix and
    // the test can run twice against the same database.
    campaignCode = `AN${randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`;
    const campaign = await request(app)
      .post(`/api/events/${eventId}/promo-campaigns`)
      .set(auth)
      .send({
        name: 'Spring deal',
        code: campaignCode,
        discount_type: 'percent',
        discount_value: 20,
        ticket_type_ids: [earlyBirdId],
      });
    expect(campaign.status).toBe(201);
    campaignId = campaign.body.campaign.id;

    const staff = await register('Analytics Door Staff');
    staffToken = staff.token;
    const assigned = await request(app)
      .post(`/api/events/${eventId}/staff`)
      .set(auth)
      .send({ email: staff.email });
    expect(assigned.status).toBe(201);

    const buyer = await register('Analytics Buyer');
    buyerToken = buyer.token;

    // A: two Early Bird tickets, paid.
    orders.a = await paidOrder(earlyBirdId, 2, buyerToken);
    // B: one VIP ticket, paid and then refunded.
    orders.b = await paidOrder(vipId, 1, buyerToken);
    await request(app)
      .post(`/api/events/${eventId}/orders/${orders.b}/refund`)
      .set(auth)
      .expect(200);
    // C: three free tickets.
    orders.c = await paidOrder(freeId, 3, buyerToken);
    // D: one Early Bird ticket with the campaign code.
    orders.d = await paidOrder(earlyBirdId, 1, buyerToken, campaignCode);
    // E: one Early Bird ticket left pending, holding a seat.
    const pending = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ event_id: eventId, items: [{ ticket_type_id: earlyBirdId, quantity: 1 }] });
    expect(pending.status).toBe(201);
    orders.e = pending.body.order.id;

    // The QR code A1 is scanned later, so its payload has to be known here.
    const ticket = await request(app)
      .get('/api/orders/' + orders.a)
      .set('Authorization', `Bearer ${buyerToken}`);
    expect(ticket.status).toBe(200);
    earlyTicketQr = ticket.body.order.tickets[0].qr_payload as string;
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

  async function paidOrder(
    ticketTypeId: string,
    quantity: number,
    token: string,
    promoCode?: string,
  ): Promise<string> {
    const created = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({
        event_id: eventId,
        items: [{ ticket_type_id: ticketTypeId, quantity }],
        ...(promoCode ? { promo_code: promoCode } : {}),
      });
    expect(created.status).toBe(201);
    const orderId = created.body.order.id as string;
    const paid = await request(app)
      .post(`/api/orders/${orderId}/pay`)
      .set('Authorization', `Bearer ${token}`);
    expect(paid.status).toBe(200);
    return orderId;
  }

  const get = (query: Record<string, string> = {}, token = organizerToken) =>
    request(app)
      .get(`/api/events/${eventId}/analytics`)
      .query(query)
      .set('Authorization', `Bearer ${token}`);

  // Orders are written by the real endpoints, so the days they belong to are moved
  // afterwards: the test needs an exact date, not "now".
  async function setCreatedAt(orderId: string, iso: string): Promise<void> {
    await pool.query('UPDATE orders SET created_at = $2 WHERE id = $1', [orderId, iso]);
  }

  it('refuses another user, who is not the event organizer', async () => {
    const res = await get({}, buyerToken);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('adds the event up from its orders, tickets, refunds and campaign', async () => {
    const res = await get();

    expect(res.status).toBe(200);
    expect(res.body.event).toMatchObject({
      id: eventId,
      title: 'Analytics test event',
      status: 'published',
    });
    expect(res.body.filters).toEqual({ from: null, to: null, ticket_type_id: null });
    // 115 seats, 6 sold for good, 1 held by the pending order.
    expect(res.body.sales).toEqual({
      capacity: 115,
      held: 1,
      sold: 6,
      remaining: 109,
      percent_sold: 5.2,
    });
    // The 300 ₸ and 120 ₸ processing fees are in none of these figures.
    expect(res.body.revenue).toEqual({
      currency: 'KZT',
      is_demonstration: true,
      gross: 2500000,
      discounts: 100000,
      refunds: 1000000,
      net: 1400000,
    });
    // A2, C3 and D1 are live; B's ticket went back with the refund.
    expect(res.body.check_in).toEqual({ registered: 6, checked_in: 0, absent: 6, percent: 0 });
    // Ticket types in the public detail's order: price, then name.
    expect(res.body.by_ticket_type).toEqual([
      {
        ticket_type_id: freeId,
        name: 'Free',
        price: 0,
        is_hidden: false,
        capacity: 100,
        sold: 3,
        remaining: 97,
        gross: 0,
        registered: 3,
        checked_in: 0,
        absent: 3,
      },
      {
        ticket_type_id: earlyBirdId,
        name: 'Early Bird',
        price: 500000,
        is_hidden: false,
        capacity: 10,
        sold: 3,
        remaining: 7,
        gross: 1500000,
        registered: 3,
        checked_in: 0,
        absent: 3,
      },
      // The refunded VIP sale is still in gross, before the refund is subtracted.
      {
        ticket_type_id: vipId,
        name: 'VIP',
        price: 1000000,
        is_hidden: false,
        capacity: 5,
        sold: 0,
        remaining: 5,
        gross: 1000000,
        registered: 0,
        checked_in: 0,
        absent: 0,
      },
    ]);
    expect(res.body.over_time).toHaveLength(1);
    expect(res.body.over_time[0]).toMatchObject({
      orders: 4,
      tickets: 7,
      gross: 2500000,
      discounts: 100000,
      net: 2400000,
    });
    expect(res.body.over_time[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(res.body.campaigns).toEqual([
      {
        id: campaignId,
        name: 'Spring deal',
        code: campaignCode,
        is_active: true,
        redemptions: 1,
        orders: 1,
        tickets_sold: 1,
        gross_revenue: 500000,
        discount_total: 100000,
        net_revenue: 400000,
      },
    ]);
  });

  it('counts a scanned ticket as attended and its order mates as absent', async () => {
    const scan = await request(app)
      .post('/api/staff/check-in')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ event_id: eventId, qr_payload: earlyTicketQr });
    expect(scan.status).toBe(200);
    expect(scan.body.result).toBe('valid');

    const res = await get();

    expect(res.status).toBe(200);
    // One of six: 16.6 with two decimals, 16.7 rounded to one.
    expect(res.body.check_in).toEqual({ registered: 6, checked_in: 1, absent: 5, percent: 16.7 });
    const earlyBird = res.body.by_ticket_type.find(
      (row: { ticket_type_id: string }) => row.ticket_type_id === earlyBirdId,
    );
    expect(earlyBird).toMatchObject({ registered: 3, checked_in: 1, absent: 2 });
  });

  it('filters by a local day, with the boundary on Kazakhstan time', async () => {
    // 20:00Z on October 20 is 01:00 on October 21 in Almaty, so A belongs to the 21st.
    await setCreatedAt(orders.a, '2026-10-20T20:00:00Z');
    // 15:00 local on the 20th.
    await setCreatedAt(orders.d, '2026-10-20T10:00:00Z');
    // Exactly local midnight: the first instant of the 20th, inside the range.
    await setCreatedAt(orders.c, '2026-10-19T19:00:00Z');
    // One minute before local midnight: the 19th, outside it.
    await setCreatedAt(orders.b, '2026-10-19T18:59:00Z');

    const res = await get({ from: '2026-10-20', to: '2026-10-21' });

    expect(res.status).toBe(200);
    expect(res.body.filters).toEqual({
      from: '2026-10-20',
      to: '2026-10-21',
      ticket_type_id: null,
    });
    // C3 and D1 sold in that local day; A and B are on the days either side of it.
    expect(res.body.sales).toEqual({
      capacity: 115,
      held: 0,
      sold: 4,
      remaining: 111,
      percent_sold: 3.5,
    });
    expect(res.body.revenue).toEqual({
      currency: 'KZT',
      is_demonstration: true,
      gross: 500000,
      discounts: 100000,
      refunds: 0,
      net: 400000,
    });
    // Only C and D sold in the range, so the ticket scanned in A is not counted here.
    expect(res.body.check_in).toEqual({ registered: 4, checked_in: 0, absent: 4, percent: 0 });
    expect(res.body.over_time).toEqual([
      { date: '2026-10-20', orders: 2, tickets: 4, gross: 500000, discounts: 100000, net: 400000 },
    ]);
    // Campaign numbers are lifetime figures: the range does not narrow them.
    expect(res.body.campaigns[0]).toMatchObject({
      redemptions: 1,
      orders: 1,
      tickets_sold: 1,
      net_revenue: 400000,
    });
  });

  it('narrows to one ticket type, counting the orders that include it whole', async () => {
    const res = await get({ ticket_type_id: vipId });

    expect(res.status).toBe(200);
    expect(res.body.sales).toEqual({
      capacity: 5,
      held: 0,
      sold: 0,
      remaining: 5,
      percent_sold: 0,
    });
    // B is the only order with a VIP ticket, and it was refunded: collected, then
    // given back, so net is 0. The order's discount cannot be split by type, which is
    // why it is counted whole.
    expect(res.body.revenue).toEqual({
      currency: 'KZT',
      is_demonstration: true,
      gross: 1000000,
      discounts: 0,
      refunds: 1000000,
      net: 0,
    });
    expect(res.body.by_ticket_type).toEqual([
      {
        ticket_type_id: vipId,
        name: 'VIP',
        price: 1000000,
        is_hidden: false,
        capacity: 5,
        sold: 0,
        remaining: 5,
        gross: 1000000,
        registered: 0,
        checked_in: 0,
        absent: 0,
      },
    ]);
    expect(res.body.check_in).toEqual({ registered: 0, checked_in: 0, absent: 0, percent: 0 });
    // The campaign covers Early Bird only, so it is not listed for VIP.
    expect(res.body.campaigns).toEqual([]);
  });

  it('rejects a ticket type that belongs to another event', async () => {
    const otherEvent = await pool.query<{ id: string }>(
      `INSERT INTO events (organizer_id, title, venue_name, venue_address, starts_at, ends_at, status)
       SELECT organizer_id, 'Other event', 'Test venue', 'Test address',
              now() + interval '9 days', now() + interval '9 days 2 hours', 'draft'
         FROM events WHERE id = $1
       RETURNING id`,
      [eventId],
    );
    const foreignType = await pool.query<{ id: string }>(
      `INSERT INTO ticket_types (event_id, name, price, quantity_total)
       VALUES ($1, 'Foreign', 100000, 5)
       RETURNING id`,
      [otherEvent.rows[0]!.id],
    );

    const res = await get({ ticket_type_id: foreignType.rows[0]!.id });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});
