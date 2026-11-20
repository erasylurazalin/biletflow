/**
 * Promo codes against a real Postgres: the redemption limit under concurrency, the
 * discount math, hidden ticket types, the refusal messages, the campaign link and QR
 * code, and the report numbers. Skipped without TEST_DATABASE_URL. Setup follows
 * refunds.db.test.ts.
 */
import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Promo codes are unique across the platform, so every run gets its own suffix and the
// suite can run twice against the same database.
const RUN = randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)('promo codes against a real database', () => {
  let app: Express;
  let pool: Pool;
  let organizerId: string;
  let organizerToken: string;
  let eventId: string;
  let typeIdA: string;
  let typeIdB: string;
  let typeIdH: string;
  let staffToken: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.JWT_SECRET ??= 'test-jwt-secret';
    ({ pool } = await import('../db/pool'));
    const { createApp } = await import('../app');
    app = createApp();

    // The organizer, with a verified identity and a payout account, on a published
    // event with paid sales active and three ticket types: A, B and a hidden H.
    const organizer = await register('Promo Organizer');
    organizerId = organizer.id;
    await pool.query('UPDATE users SET email_verified_at = now() WHERE id = $1', [organizer.id]);
    const profile = await request(app)
      .post('/api/me/organizer-profile')
      .set('Authorization', `Bearer ${organizer.token}`)
      .send({
        display_name: 'Promo Test Organizer',
        contact_email: 'organizer@test.biletflow.kz',
        payout: { bank_name: 'Demo Bank', iban: 'KZ000000000000000000', account_holder: 'Test' },
      });
    expect(profile.status).toBe(201);
    organizerToken = profile.body.token as string;

    const event = await pool.query<{ id: string }>(
      `INSERT INTO events (organizer_id, title, venue_name, venue_address, starts_at, ends_at, status)
       VALUES ($1, 'Promo test event', 'Test venue', 'Test address',
               now() + interval '7 days', now() + interval '7 days 2 hours', 'published')
       RETURNING id`,
      [organizer.id],
    );
    eventId = event.rows[0]!.id;

    const typeA = await request(app)
      .post(`/api/events/${eventId}/ticket-types`)
      .set('Authorization', `Bearer ${organizerToken}`)
      .send({ name: 'Standard', price: 500000, quantity_total: 50 });
    expect(typeA.status).toBe(201);
    typeIdA = typeA.body.ticket_type.id;

    const typeB = await request(app)
      .post(`/api/events/${eventId}/ticket-types`)
      .set('Authorization', `Bearer ${organizerToken}`)
      .send({ name: 'Premium', price: 800000, quantity_total: 50 });
    expect(typeB.status).toBe(201);
    typeIdB = typeB.body.ticket_type.id;

    const typeH = await request(app)
      .post(`/api/events/${eventId}/ticket-types`)
      .set('Authorization', `Bearer ${organizerToken}`)
      .send({ name: 'Hidden', price: 300000, quantity_total: 50, is_hidden: true });
    expect(typeH.status).toBe(201);
    typeIdH = typeH.body.ticket_type.id;

    const auth = { Authorization: `Bearer ${organizerToken}` };
    const base = `/api/events/${eventId}/paid-sales`;
    await request(app).post('/api/me/organizer-profile/verify-identity').set(auth).expect(200);
    await request(app).post(`${base}/activation-fee`).set(auth).expect(200);
    await request(app).post(`${base}/terms`).set(auth).send({ accepted: true }).expect(200);
    await request(app).post(`${base}/activate`).set(auth).expect(200);

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

  interface CreateCampaignInput {
    name: string;
    discount_type: 'percent' | 'fixed';
    discount_value: number;
    code?: string;
    starts_at?: string;
    ends_at?: string;
    max_redemptions?: number;
    ticket_type_ids?: string[] | null;
  }

  async function createCampaign(input: CreateCampaignInput) {
    const res = await request(app)
      .post(`/api/events/${eventId}/promo-campaigns`)
      .set('Authorization', `Bearer ${organizerToken}`)
      .send(input);
    expect(res.status).toBe(201);
    return res.body.campaign as { id: string; code: string; token: string; link: string };
  }

  function buy(
    token: string,
    items: { ticket_type_id: string; quantity: number }[],
    promo?: string,
  ) {
    return request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({
        event_id: eventId,
        items,
        ...(promo && { promo_code: promo }),
      });
  }

  function pay(token: string, orderId: string) {
    return request(app).post(`/api/orders/${orderId}/pay`).set('Authorization', `Bearer ${token}`);
  }

  function refund(token: string, orderId: string) {
    return request(app)
      .post(`/api/events/${eventId}/orders/${orderId}/refund`)
      .set('Authorization', `Bearer ${token}`);
  }

  async function redemptionCount(campaignId: string): Promise<number> {
    const result = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM promo_redemptions WHERE campaign_id = $1`,
      [campaignId],
    );
    return result.rows[0]!.count;
  }

  it('gives the code to exactly three of ten simultaneous buyers', async () => {
    const campaign = await createCampaign({
      name: 'Concurrency',
      discount_type: 'percent',
      discount_value: 10,
      code: `LIMIT3${RUN}`,
      max_redemptions: 3,
    });

    const buyers = await Promise.all(
      Array.from({ length: 10 }, () => register('Concurrency Buyer')),
    );
    const attempts = await Promise.all(
      buyers.map((buyer) =>
        buy(buyer.token, [{ ticket_type_id: typeIdA, quantity: 1 }], `limit3${RUN.toLowerCase()}`),
      ),
    );
    const statuses = attempts.map((res) => res.status).sort();
    expect(statuses).toEqual([...Array(3).fill(201), ...Array(7).fill(409)]);
    for (const res of attempts) {
      if (res.status === 409) {
        expect(res.body.error.code).toBe('PROMO_CODE_INVALID');
        expect(res.body.error.message).toBe('This promo code has been fully used');
      }
    }
    expect(await redemptionCount(campaign.id)).toBe(3);
  });

  it('frees the code when an order is abandoned', async () => {
    const campaign = await createCampaign({
      name: 'Abandoned',
      discount_type: 'percent',
      discount_value: 10,
      code: `ONCE11${RUN}`,
      max_redemptions: 1,
    });
    const first = await register('Abandoned Buyer 1');
    const second = await register('Abandoned Buyer 2');
    const third = await register('Abandoned Buyer 3');

    const placed = await buy(
      first.token,
      [{ ticket_type_id: typeIdA, quantity: 1 }],
      `ONCE11${RUN}`,
    );
    expect(placed.status).toBe(201);
    const orderId = placed.body.order.id as string;

    const refused = await buy(
      second.token,
      [{ ticket_type_id: typeIdA, quantity: 1 }],
      `ONCE11${RUN}`,
    );
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toBe('This promo code has been fully used');

    await pool.query(`UPDATE orders SET expires_at = now() - interval '1 minute' WHERE id = $1`, [
      orderId,
    ]);

    const again = await buy(
      third.token,
      [{ ticket_type_id: typeIdA, quantity: 1 }],
      `ONCE11${RUN}`,
    );
    expect(again.status).toBe(201);

    // The rows stay; only their count stops.
    expect(await redemptionCount(campaign.id)).toBe(2);
  });

  it('applies a percent discount and collects the payment on it', async () => {
    await createCampaign({
      name: 'Twenty percent',
      discount_type: 'percent',
      discount_value: 20,
      code: `PCT020${RUN}`,
    });
    const buyer = await register('Percent Buyer');

    const placed = await buy(
      buyer.token,
      [{ ticket_type_id: typeIdA, quantity: 2 }],
      `PCT020${RUN}`,
    );
    expect(placed.status).toBe(201);
    expect(placed.body.order).toMatchObject({
      subtotal: 1000000,
      discount: 200000,
      processing_fee: 24000,
      total: 824000,
    });
    expect(placed.body.order.promo).toEqual({
      code: `PCT020${RUN}`,
      campaign_name: 'Twenty percent',
    });
    const orderId = placed.body.order.id as string;

    const paid = await pay(buyer.token, orderId);
    expect(paid.status).toBe(200);
    expect(paid.body.order.payment.amount).toBe(824000);
  });

  it('applies a fixed discount only to covered ticket types, capped once', async () => {
    await createCampaign({
      name: 'Fixed on A',
      discount_type: 'fixed',
      discount_value: 300000,
      code: `FIXA01${RUN}`,
      ticket_type_ids: [typeIdA],
    });
    await createCampaign({
      name: 'Capped on A',
      discount_type: 'fixed',
      discount_value: 900000,
      code: `CAP901${RUN}`,
      ticket_type_ids: [typeIdA],
    });
    const buyer = await register('Fixed Buyer');

    // One A and one B: the B ticket pays full price and the fee is on what is left.
    const mixed = await buy(
      buyer.token,
      [
        { ticket_type_id: typeIdA, quantity: 1 },
        { ticket_type_id: typeIdB, quantity: 1 },
      ],
      `FIXA01${RUN}`,
    );
    expect(mixed.status).toBe(201);
    expect(mixed.body.order).toMatchObject({
      subtotal: 1300000,
      discount: 300000,
      processing_fee: 30000,
      total: 1030000,
    });

    // A fixed discount larger than the covered tickets is capped at them, once.
    const capped = await buy(
      buyer.token,
      [{ ticket_type_id: typeIdA, quantity: 1 }],
      `CAP901${RUN}`,
    );
    expect(capped.status).toBe(201);
    expect(capped.body.order).toMatchObject({
      subtotal: 500000,
      discount: 500000,
      processing_fee: 0,
      total: 0,
    });
  });

  it('sells a hidden ticket type only through a code that lists it', async () => {
    await createCampaign({
      name: 'Covers the hidden type',
      discount_type: 'percent',
      discount_value: 10,
      code: `HIDYES${RUN}`,
      ticket_type_ids: [typeIdA, typeIdH],
    });
    await createCampaign({
      name: 'Misses the hidden type',
      discount_type: 'percent',
      discount_value: 10,
      code: `HIDNO1${RUN}`,
      ticket_type_ids: [typeIdA],
    });
    const buyer = await register('Hidden Buyer');

    const withoutCode = await buy(buyer.token, [{ ticket_type_id: typeIdH, quantity: 1 }]);
    expect(withoutCode.status).toBe(400);

    const withCode = await buy(
      buyer.token,
      [{ ticket_type_id: typeIdH, quantity: 1 }],
      `HIDYES${RUN}`,
    );
    expect(withCode.status).toBe(201);
    expect(withCode.body.order).toMatchObject({ subtotal: 300000, discount: 30000, total: 278100 });

    const wrongCode = await buy(
      buyer.token,
      [{ ticket_type_id: typeIdH, quantity: 1 }],
      `HIDNO1${RUN}`,
    );
    expect(wrongCode.status).toBe(400);
  });

  it('refuses invalid, foreign, disabled, early, expired and inapplicable codes', async () => {
    // A code of another event of the same organizer.
    const otherEvent = await pool.query<{ id: string }>(
      `INSERT INTO events (organizer_id, title, venue_name, venue_address, starts_at, ends_at, status)
       VALUES ($1, 'Other promo event', 'Test venue', 'Test address',
               now() + interval '7 days', now() + interval '7 days 2 hours', 'published')
       RETURNING id`,
      [organizerId],
    );
    const otherEventId = otherEvent.rows[0]!.id;
    const foreign = await request(app)
      .post(`/api/events/${otherEventId}/promo-campaigns`)
      .set('Authorization', `Bearer ${organizerToken}`)
      .send({
        name: 'Other event',
        discount_type: 'percent',
        discount_value: 10,
        code: `OTHER1${RUN}`,
      });
    expect(foreign.status).toBe(201);

    const disabled = await createCampaign({
      name: 'Disabled',
      discount_type: 'percent',
      discount_value: 10,
      code: `GONE11${RUN}`,
    });
    const patch = await request(app)
      .patch(`/api/promo-campaigns/${disabled.id}`)
      .set('Authorization', `Bearer ${organizerToken}`)
      .send({ is_active: false });
    expect(patch.status).toBe(200);

    await createCampaign({
      name: 'Not started',
      discount_type: 'percent',
      discount_value: 10,
      code: `EARLY1${RUN}`,
      starts_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    });
    await createCampaign({
      name: 'Expired',
      discount_type: 'percent',
      discount_value: 10,
      code: `OLDCDE${RUN}`,
      ends_at: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
    });
    await createCampaign({
      name: 'Only A',
      discount_type: 'percent',
      discount_value: 10,
      code: `ONLYA1${RUN}`,
      ticket_type_ids: [typeIdA],
    });

    const buyer = await register('Refusal Buyer');
    const cases: [string, string][] = [
      ['NOPE12', 'This promo code is not valid'],
      [foreign.body.campaign.code, 'This promo code is not valid'],
      [`GONE11${RUN}`, 'This promo code is no longer active'],
      [`EARLY1${RUN}`, 'This promo code is not active yet'],
      [`OLDCDE${RUN}`, 'This promo code has expired'],
      [`ONLYA1${RUN}`, 'This promo code does not apply to the selected tickets'],
    ];
    for (const [code, message] of cases) {
      const res = await buy(buyer.token, [{ ticket_type_id: typeIdB, quantity: 1 }], code);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PROMO_CODE_INVALID');
      expect(res.body.error.message).toBe(message);
    }
  });

  it('serves the link and its QR code, and the scanner rejects the QR code', async () => {
    const campaign = await createCampaign({
      name: 'Link test',
      discount_type: 'fixed',
      discount_value: 300000,
      code: `QRTEST1${RUN}`,
    });

    const promo = await request(app).get(`/api/promo/${campaign.token}`);
    expect(promo.status).toBe(200);
    expect(promo.body.promo).toMatchObject({ code: `QRTEST1${RUN}`, event_id: eventId });

    // The link carries the token and nothing about the discount or any price.
    expect(campaign.link).toBe(`http://localhost:3001/events/${eventId}?promo=${campaign.token}`);
    expect(campaign.link).not.toContain('300000');
    expect(campaign.link).not.toContain(`QRTEST1${RUN}`);

    const qr = await request(app)
      .get(`/api/promo-campaigns/${campaign.id}/qr.png`)
      .set('Authorization', `Bearer ${organizerToken}`);
    expect(qr.status).toBe(200);
    expect(qr.headers['content-type']).toBe('image/png');
    // PNG magic number.
    expect(qr.body.subarray(0, 4).toString('binary')).toBe('\x89PNG');

    const scanned = await request(app)
      .post('/api/staff/check-in')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ event_id: eventId, qr_payload: campaign.link });
    expect(scanned.status).toBe(200);
    expect(scanned.body).toEqual({ result: 'invalid', ticket: null });
  });

  it('reports the paid orders only, with live redemptions', async () => {
    const campaign = await createCampaign({
      name: 'Report test',
      discount_type: 'percent',
      discount_value: 20,
      code: `REPORT1${RUN}`,
    });
    const buyers = await Promise.all([
      register('Report Buyer 1'),
      register('Report Buyer 2'),
      register('Report Buyer 3'),
    ]);

    const placed: string[] = [];
    for (const buyer of buyers) {
      const res = await buy(
        buyer.token,
        [{ ticket_type_id: typeIdA, quantity: 1 }],
        `REPORT1${RUN}`,
      );
      expect(res.status).toBe(201);
      placed.push(res.body.order.id as string);
    }
    for (const [index, orderId] of placed.entries()) {
      expect((await pay(buyers[index]!.token, orderId)).status).toBe(200);
    }
    expect((await refund(organizerToken, placed[0]!)).status).toBe(200);

    const list = await request(app)
      .get(`/api/events/${eventId}/promo-campaigns`)
      .set('Authorization', `Bearer ${organizerToken}`);
    expect(list.status).toBe(200);
    const report = list.body.campaigns.find((c: { id: string }) => c.id === campaign.id);
    expect(report).toMatchObject({
      // The refunded order's redemption stays in the table but does not count.
      redemptions: 2,
      orders: 2,
      tickets_sold: 2,
      gross_revenue: 1000000,
      discount_total: 200000,
      net_revenue: 800000,
    });
  });

  it('keeps other organizers out of every campaign endpoint', async () => {
    const second = await register('Second Organizer');
    await pool.query('UPDATE users SET email_verified_at = now() WHERE id = $1', [second.id]);
    const secondProfile = await request(app)
      .post('/api/me/organizer-profile')
      .set('Authorization', `Bearer ${second.token}`)
      .send({
        display_name: 'Second Promo Organizer',
        contact_email: 'second@test.biletflow.kz',
      });
    expect(secondProfile.status).toBe(201);
    const secondToken = secondProfile.body.token as string;

    const created = await createCampaign({
      name: 'Mine',
      discount_type: 'percent',
      discount_value: 10,
      code: `MINE11${RUN}`,
    });

    const forbiddenCreate = await request(app)
      .post(`/api/events/${eventId}/promo-campaigns`)
      .set('Authorization', `Bearer ${secondToken}`)
      .send({ name: 'Theirs', discount_type: 'percent', discount_value: 10 });
    expect(forbiddenCreate.status).toBe(403);

    const forbiddenList = await request(app)
      .get(`/api/events/${eventId}/promo-campaigns`)
      .set('Authorization', `Bearer ${secondToken}`);
    expect(forbiddenList.status).toBe(403);

    const forbiddenPatch = await request(app)
      .patch(`/api/promo-campaigns/${created.id}`)
      .set('Authorization', `Bearer ${secondToken}`)
      .send({ is_active: false });
    expect(forbiddenPatch.status).toBe(403);

    const forbiddenQr = await request(app)
      .get(`/api/promo-campaigns/${created.id}/qr.png`)
      .set('Authorization', `Bearer ${secondToken}`);
    expect(forbiddenQr.status).toBe(403);
  });
});
