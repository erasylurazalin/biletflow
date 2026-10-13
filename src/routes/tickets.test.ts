/**
 * Tests for the ticket endpoints. Same approach as ticket-types.test.ts: the pool is
 * faked, so ownership and the response shape run for real but the SQL does not.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../db/pool', () => ({ pool: { query: vi.fn() } }));

import { pool } from '../db/pool';
import { createApp } from '../app';
import { verifyTicketPayload } from '../lib/qr';
import { signToken } from '../middleware/auth';

const query = vi.mocked(pool.query);
const app = createApp();

const BUYER_ID = '22222222-2222-4222-8222-222222222222';
const STRANGER_ID = '88888888-8888-4888-8888-888888888888';
const EVENT_ID = '33333333-3333-4333-8333-333333333333';
const TICKET_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const ticketRow = {
  id: TICKET_ID,
  code: 'BF-7K2M-9XQP',
  status: 'valid',
  attendee_name: 'Aidos K.',
  ticket_type_name: 'Early Bird',
  event_id: EVENT_ID,
  event_title: 'Astana Tech Meetup',
  event_starts_at: '2026-11-14T18:00:00.000Z',
  event_venue_name: 'Nazarbayev University',
};

function rows(value: unknown[]) {
  return { rows: value } as never;
}

function bearer(userId = BUYER_ID) {
  return `Bearer ${signToken({ id: userId, role: 'attendee' })}`;
}

beforeEach(() => {
  query.mockReset();
  process.env.JWT_SECRET = 'test-jwt-secret';
});

describe('GET /api/tickets', () => {
  it('lists my tickets in the docs/api.md shape, with a QR payload that verifies', async () => {
    query.mockResolvedValueOnce(rows([ticketRow]));

    const res = await request(app).get('/api/tickets').set('Authorization', bearer());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      tickets: [
        {
          id: TICKET_ID,
          code: 'BF-7K2M-9XQP',
          status: 'valid',
          attendee_name: 'Aidos K.',
          ticket_type_name: 'Early Bird',
          event: {
            id: EVENT_ID,
            title: 'Astana Tech Meetup',
            starts_at: '2026-11-14T18:00:00.000Z',
            venue_name: 'Nazarbayev University',
          },
          qr_payload: expect.stringMatching(/^BF1:/),
        },
      ],
      limit: 20,
      offset: 0,
    });
    expect(verifyTicketPayload(res.body.tickets[0].qr_payload)).toEqual({
      ok: true,
      ticketId: TICKET_ID,
    });
    expect(query.mock.calls[0]?.[1]).toEqual([BUYER_ID, 20, 0]);
  });

  it('returns 401 without a token', async () => {
    const res = await request(app).get('/api/tickets');

    expect(res.status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('GET /api/tickets/:id', () => {
  it('returns one of my tickets', async () => {
    query.mockResolvedValueOnce(rows([ticketRow]));

    const res = await request(app).get(`/api/tickets/${TICKET_ID}`).set('Authorization', bearer());

    expect(res.status).toBe(200);
    expect(res.body.ticket.id).toBe(TICKET_ID);
    expect(query.mock.calls[0]?.[1]).toEqual([TICKET_ID, BUYER_ID]);
  });

  it("returns 404 TICKET_NOT_FOUND for somebody else's ticket", async () => {
    query.mockResolvedValueOnce(rows([]));

    const res = await request(app)
      .get(`/api/tickets/${TICKET_ID}`)
      .set('Authorization', bearer(STRANGER_ID));

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('TICKET_NOT_FOUND');
  });
});
