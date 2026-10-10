/**
 * Tests for the organizer ticket type endpoints. Same approach as events.test.ts: the
 * pool is faked, so the owner check and validation run for real but the SQL does not.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../db/pool', () => ({ pool: { query: vi.fn() } }));

import { pool } from '../db/pool';
import { createApp } from '../app';
import { signToken } from '../middleware/auth';

const query = vi.mocked(pool.query);
const app = createApp();

const ORGANIZER_ID = '11111111-1111-4111-8111-111111111111';
const STRANGER_ID = '22222222-2222-4222-8222-222222222222';
const EVENT_ID = '33333333-3333-4333-8333-333333333333';
const TICKET_TYPE_ID = '55555555-5555-4555-8555-555555555555';

const ticketTypeRow = {
  id: TICKET_TYPE_ID,
  name: 'Early Bird',
  price: 500000,
  currency: 'KZT',
  quantity_total: 100,
  quantity_available: 57,
  sales_start_at: null,
  sales_end_at: null,
  is_hidden: false,
};

// What loadOwnedTicketType() reads: the ticket type plus its owner and held seats.
const existingRow = { ...ticketTypeRow, held: 43, organizer_id: ORGANIZER_ID };

function rows(value: unknown[]) {
  return { rows: value } as never;
}

function bearer(userId: string) {
  return `Bearer ${signToken({ id: userId, role: 'organizer' })}`;
}

beforeEach(() => {
  query.mockReset();
  process.env.JWT_SECRET = 'test-jwt-secret';
});

describe('POST /api/events/:id/ticket-types', () => {
  const body = { name: 'Early Bird', price: 500000, quantity_total: 100 };

  it('creates the ticket type on my event with defaults filled in', async () => {
    query
      .mockResolvedValueOnce(rows([{ organizer_id: ORGANIZER_ID }]))
      .mockResolvedValueOnce(rows([{ ...ticketTypeRow, quantity_available: 100 }]));

    const res = await request(app)
      .post(`/api/events/${EVENT_ID}/ticket-types`)
      .set('Authorization', bearer(ORGANIZER_ID))
      .send(body);

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ticket_type: { ...ticketTypeRow, quantity_available: 100 } });
    expect(query.mock.calls[1]?.[1]).toEqual([
      EVENT_ID,
      'Early Bird',
      500000,
      'KZT',
      100,
      null,
      null,
      false,
    ]);
  });

  it('returns 401 without a token', async () => {
    const res = await request(app).post(`/api/events/${EVENT_ID}/ticket-types`).send(body);

    expect(res.status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });

  it("returns 403 on somebody else's event and writes nothing", async () => {
    query.mockResolvedValueOnce(rows([{ organizer_id: ORGANIZER_ID }]));

    const res = await request(app)
      .post(`/api/events/${EVENT_ID}/ticket-types`)
      .set('Authorization', bearer(STRANGER_ID))
      .send(body);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('returns 404 when the event does not exist', async () => {
    query.mockResolvedValueOnce(rows([]));

    const res = await request(app)
      .post(`/api/events/${EVENT_ID}/ticket-types`)
      .set('Authorization', bearer(ORGANIZER_ID))
      .send(body);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('EVENT_NOT_FOUND');
  });

  it.each([
    ['a negative price', { ...body, price: -1 }],
    ['a price that is not whole tiyn', { ...body, price: 5000.5 }],
    ['a missing name', { price: 500000, quantity_total: 100 }],
    ['a currency other than KZT', { ...body, currency: 'USD' }],
    ['a timestamp that is not ISO 8601', { ...body, sales_start_at: 'next friday' }],
    [
      'a sales window that ends before it starts',
      { ...body, sales_start_at: '2026-11-10T00:00:00Z', sales_end_at: '2026-11-01T00:00:00Z' },
    ],
  ])('returns 400 for %s, without touching the database', async (_label, invalid) => {
    const res = await request(app)
      .post(`/api/events/${EVENT_ID}/ticket-types`)
      .set('Authorization', bearer(ORGANIZER_ID))
      .send(invalid);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(query).not.toHaveBeenCalled();
  });

  it('returns 400 when the event id is not a UUID', async () => {
    const res = await request(app)
      .post('/api/events/banana/ticket-types')
      .set('Authorization', bearer(ORGANIZER_ID))
      .send(body);

    expect(res.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/ticket-types/:id', () => {
  it('changes only the fields sent and keeps the rest', async () => {
    query
      .mockResolvedValueOnce(rows([existingRow]))
      .mockResolvedValueOnce(rows([{ ...ticketTypeRow, price: 400000 }]));

    const res = await request(app)
      .patch(`/api/ticket-types/${TICKET_TYPE_ID}`)
      .set('Authorization', bearer(ORGANIZER_ID))
      .send({ price: 400000 });

    expect(res.status).toBe(200);
    expect(res.body.ticket_type).toEqual({ ...ticketTypeRow, price: 400000 });
    expect(query.mock.calls[1]?.[1]).toEqual([
      TICKET_TYPE_ID,
      'Early Bird',
      400000,
      'KZT',
      100,
      null,
      null,
      false,
    ]);
  });

  it("returns 403 on a ticket type of somebody else's event and writes nothing", async () => {
    query.mockResolvedValueOnce(rows([existingRow]));

    const res = await request(app)
      .patch(`/api/ticket-types/${TICKET_TYPE_ID}`)
      .set('Authorization', bearer(STRANGER_ID))
      .send({ price: 1 });

    expect(res.status).toBe(403);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('returns 404 when the ticket type does not exist', async () => {
    query.mockResolvedValueOnce(rows([]));

    const res = await request(app)
      .patch(`/api/ticket-types/${TICKET_TYPE_ID}`)
      .set('Authorization', bearer(ORGANIZER_ID))
      .send({ price: 1 });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('returns 409 when quantity_total would drop below the seats orders hold', async () => {
    query.mockResolvedValueOnce(rows([existingRow]));

    const res = await request(app)
      .patch(`/api/ticket-types/${TICKET_TYPE_ID}`)
      .set('Authorization', bearer(ORGANIZER_ID))
      .send({ quantity_total: 42 });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('returns 409 when an order came in between the check and the update', async () => {
    query.mockResolvedValueOnce(rows([existingRow])).mockResolvedValueOnce(rows([]));

    const res = await request(app)
      .patch(`/api/ticket-types/${TICKET_TYPE_ID}`)
      .set('Authorization', bearer(ORGANIZER_ID))
      .send({ quantity_total: 43 });

    expect(res.status).toBe(409);
  });

  it('returns 400 for an empty body, without touching the database', async () => {
    const res = await request(app)
      .patch(`/api/ticket-types/${TICKET_TYPE_ID}`)
      .set('Authorization', bearer(ORGANIZER_ID))
      .send({});

    expect(res.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it('returns 400 when a new sales end falls before the stored sales start', async () => {
    query.mockResolvedValueOnce(
      rows([{ ...existingRow, sales_start_at: new Date('2026-11-10T00:00:00Z') }]),
    );

    const res = await request(app)
      .patch(`/api/ticket-types/${TICKET_TYPE_ID}`)
      .set('Authorization', bearer(ORGANIZER_ID))
      .send({ sales_end_at: '2026-11-01T00:00:00Z' });

    expect(res.status).toBe(400);
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe('DELETE /api/ticket-types/:id', () => {
  it('deletes a ticket type on my event', async () => {
    query.mockResolvedValueOnce(rows([existingRow])).mockResolvedValueOnce(rows([]));

    const res = await request(app)
      .delete(`/api/ticket-types/${TICKET_TYPE_ID}`)
      .set('Authorization', bearer(ORGANIZER_ID));

    expect(res.status).toBe(204);
    expect(query.mock.calls[1]?.[1]).toEqual([TICKET_TYPE_ID]);
  });

  it("returns 403 on a ticket type of somebody else's event and deletes nothing", async () => {
    query.mockResolvedValueOnce(rows([existingRow]));

    const res = await request(app)
      .delete(`/api/ticket-types/${TICKET_TYPE_ID}`)
      .set('Authorization', bearer(STRANGER_ID));

    expect(res.status).toBe(403);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('returns 409 when orders point at the ticket type', async () => {
    query
      .mockResolvedValueOnce(rows([existingRow]))
      .mockRejectedValueOnce(Object.assign(new Error('fk violation'), { code: '23503' }));

    const res = await request(app)
      .delete(`/api/ticket-types/${TICKET_TYPE_ID}`)
      .set('Authorization', bearer(ORGANIZER_ID));

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('returns 400 when the id is not a UUID', async () => {
    const res = await request(app)
      .delete('/api/ticket-types/banana')
      .set('Authorization', bearer(ORGANIZER_ID));

    expect(res.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });
});
