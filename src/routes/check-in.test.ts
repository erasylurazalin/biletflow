import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db/pool', () => {
  const query = vi.fn();
  const clientQuery = vi.fn((sql: string, ...args: unknown[]) => {
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql.trim())) {
      return Promise.resolve({ rows: [] });
    }
    return query(sql, ...args);
  });
  return {
    pool: {
      query,
      connect: vi.fn(async () => ({ query: clientQuery, release: vi.fn() })),
    },
  };
});

import { createApp } from '../app';
import { pool } from '../db/pool';
import { signToken } from '../middleware/auth';
import { signTicketPayload } from '../lib/qr';

const query = vi.mocked(pool.query);
const app = createApp();

const STAFF_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222';
const EVENT_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_EVENT_ID = '44444444-4444-4444-8444-444444444444';
const TICKET_ID = '55555555-5555-4555-8555-555555555555';
const CHECKED_IN_AT = '2026-10-24T10:00:00.000Z';

const ticketRow = {
  id: TICKET_ID,
  code: 'BF-7K2M-9XQP',
  status: 'valid',
  attendee_name: 'Aidos K.',
  ticket_type_name: 'Free admission',
  checked_in_at: null,
  event_id: EVENT_ID,
};

const ticketResponse = {
  id: TICKET_ID,
  code: ticketRow.code,
  status: ticketRow.status,
  attendee_name: ticketRow.attendee_name,
  ticket_type_name: ticketRow.ticket_type_name,
  checked_in_at: null,
};

function rows(value: unknown[]) {
  return { rows: value, rowCount: value.length } as never;
}

function assigned() {
  query.mockResolvedValueOnce(rows([{ assigned: true }]));
}

function bearer(userId = STAFF_ID) {
  return `Bearer ${signToken({ id: userId, role: 'attendee' })}`;
}

function payload(ticketId = TICKET_ID) {
  return signTicketPayload(ticketId);
}

function scan(qrPayload = payload(), userId = STAFF_ID) {
  return request(app)
    .post('/api/staff/check-in')
    .set('Authorization', bearer(userId))
    .send({ event_id: EVENT_ID, qr_payload: qrPayload });
}

function undo(userId = STAFF_ID, ticketId = TICKET_ID) {
  return request(app)
    .post(`/api/staff/check-in/${ticketId}/undo`)
    .set('Authorization', bearer(userId));
}

const statements = () => query.mock.calls.map((call) => String(call[0]));

beforeEach(() => {
  query.mockReset();
  process.env.JWT_SECRET = 'test-jwt-secret';
});

describe('check-in authentication and validation', () => {
  it('returns 401 without a token on all three endpoints', async () => {
    const responses = await Promise.all([
      request(app).post('/api/staff/check-in').send({ event_id: EVENT_ID, qr_payload: payload() }),
      request(app).post(`/api/staff/check-in/${TICKET_ID}/undo`),
      request(app).get(`/api/staff/events/${EVENT_ID}/attendees`),
    ]);

    expect(responses.map((res) => res.status)).toEqual([401, 401, 401]);
    expect(query).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { event_id: 'not-a-uuid', qr_payload: 'BF1:anything' },
    { event_id: EVENT_ID, qr_payload: '' },
  ])('returns 400 for a bad check-in body', async (body) => {
    const res = await request(app)
      .post('/api/staff/check-in')
      .set('Authorization', bearer())
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(query).not.toHaveBeenCalled();
  });

  it('returns 400 for invalid undo and attendee UUID parameters', async () => {
    const undoRes = await undo(STAFF_ID, 'not-a-uuid');
    const attendeesRes = await request(app)
      .get('/api/staff/events/not-a-uuid/attendees')
      .set('Authorization', bearer());

    expect(undoRes.status).toBe(400);
    expect(attendeesRes.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('POST /api/staff/check-in', () => {
  it('returns 403 when the user is not assigned', async () => {
    query.mockResolvedValueOnce(rows([]));

    const res = await scan();

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('returns invalid for a campaign URL without updating the database', async () => {
    assigned();

    const res = await scan('https://biletflow.kz/e/abc?c=xyz');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ result: 'invalid', ticket: null });
    expect(query).toHaveBeenCalledTimes(1);
    expect(statements().some((sql) => sql.includes('UPDATE tickets'))).toBe(false);
  });

  it('checks in a valid ticket and writes its audit entry', async () => {
    assigned();
    query
      .mockResolvedValueOnce(
        rows([{ ...ticketRow, status: 'checked_in', checked_in_at: CHECKED_IN_AT }]),
      )
      .mockResolvedValueOnce(rows([]));

    const res = await scan();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      result: 'valid',
      ticket: { ...ticketResponse, status: 'checked_in', checked_in_at: CHECKED_IN_AT },
    });
    expect(query.mock.calls[1]?.[1]).toEqual([STAFF_ID, TICKET_ID, EVENT_ID]);
    expect(statements()[2]).toContain('INSERT INTO audit_log');
    expect(query.mock.calls[2]?.[1]).toEqual([
      STAFF_ID,
      'ticket.checked_in',
      'ticket',
      TICKET_ID,
      EVENT_ID,
      `Checked in ticket ${ticketRow.code}`,
    ]);
  });

  it('returns already_used with the original check-in timestamp and no audit', async () => {
    assigned();
    query
      .mockResolvedValueOnce(rows([]))
      .mockResolvedValueOnce(
        rows([{ ...ticketRow, status: 'checked_in', checked_in_at: CHECKED_IN_AT }]),
      );

    const res = await scan();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      result: 'already_used',
      ticket: { ...ticketResponse, status: 'checked_in', checked_in_at: CHECKED_IN_AT },
      checked_in_at: CHECKED_IN_AT,
    });
    expect(query).toHaveBeenCalledTimes(3);
    expect(statements().some((sql) => sql.includes('INSERT INTO audit_log'))).toBe(false);
  });

  it.each(['cancelled', 'refunded'] as const)(
    'returns %s without an audit entry',
    async (status) => {
      assigned();
      query.mockResolvedValueOnce(rows([])).mockResolvedValueOnce(rows([{ ...ticketRow, status }]));

      const res = await scan();

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        result: status,
        ticket: { ...ticketResponse, status },
      });
      expect(query).toHaveBeenCalledTimes(3);
      expect(statements().some((sql) => sql.includes('INSERT INTO audit_log'))).toBe(false);
    },
  );

  it('returns not_found for a signed ticket id that is absent', async () => {
    assigned();
    query.mockResolvedValueOnce(rows([])).mockResolvedValueOnce(rows([]));

    const res = await scan();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ result: 'not_found', ticket: null });
    expect(query).toHaveBeenCalledTimes(3);
  });

  it("returns wrong_event without exposing the other event's attendee", async () => {
    assigned();
    query
      .mockResolvedValueOnce(rows([]))
      .mockResolvedValueOnce(rows([{ ...ticketRow, event_id: OTHER_EVENT_ID }]));

    const res = await scan();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ result: 'wrong_event', ticket: null });
    expect(res.text).not.toContain(ticketRow.attendee_name);
    expect(query).toHaveBeenCalledTimes(3);
  });
});

describe('POST /api/staff/check-in/:ticket_id/undo', () => {
  it('restores a checked-in ticket and writes its audit entry', async () => {
    query
      .mockResolvedValueOnce(
        rows([{ ...ticketRow, status: 'checked_in', checked_in_at: CHECKED_IN_AT }]),
      )
      .mockResolvedValueOnce(rows([{ assigned: true }]))
      .mockResolvedValueOnce(rows([ticketRow]))
      .mockResolvedValueOnce(rows([]));

    const res = await undo();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ticket: ticketResponse });
    expect(statements()[0]).toContain('FOR UPDATE OF t');
    expect(query.mock.calls[2]?.[1]).toEqual([TICKET_ID]);
    expect(statements()[3]).toContain('INSERT INTO audit_log');
    expect(query.mock.calls[3]?.[1]).toEqual([
      STAFF_ID,
      'ticket.check_in_reversed',
      'ticket',
      TICKET_ID,
      EVENT_ID,
      `Undid check-in of ticket ${ticketRow.code}`,
    ]);
  });

  it('returns 404 TICKET_NOT_FOUND when the ticket does not exist', async () => {
    query.mockResolvedValueOnce(rows([]));

    const res = await undo();

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('TICKET_NOT_FOUND');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("returns 403 when the user is not assigned to the ticket's event", async () => {
    query
      .mockResolvedValueOnce(rows([{ ...ticketRow, status: 'checked_in' }]))
      .mockResolvedValueOnce(rows([]));

    const res = await undo(OTHER_USER_ID);

    expect(res.status).toBe(403);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('returns 409 CONFLICT when the ticket is not checked in', async () => {
    query
      .mockResolvedValueOnce(rows([ticketRow]))
      .mockResolvedValueOnce(rows([{ assigned: true }]));

    const res = await undo();

    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'CONFLICT',
      message: 'This ticket is not checked in',
    });
    expect(query).toHaveBeenCalledTimes(2);
  });
});

describe('GET /api/staff/events/:id/attendees', () => {
  it('returns 403 when the user is not assigned', async () => {
    query.mockResolvedValueOnce(rows([]));

    const res = await request(app)
      .get(`/api/staff/events/${EVENT_ID}/attendees`)
      .set('Authorization', bearer());

    expect(res.status).toBe(403);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('returns the ticket shape and event-wide counts', async () => {
    assigned();
    query
      .mockResolvedValueOnce(rows([ticketRow]))
      .mockResolvedValueOnce(rows([{ registered: 2, checked_in: 1 }]));

    const res = await request(app)
      .get(`/api/staff/events/${EVENT_ID}/attendees?limit=10&offset=5&q=A%25_`)
      .set('Authorization', bearer());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      attendees: [ticketResponse],
      counts: { registered: 2, checked_in: 1 },
      limit: 10,
      offset: 5,
    });
    expect(query.mock.calls[1]?.[1]).toEqual([EVENT_ID, 10, 5, '%A\\%\\_%']);
    expect(query.mock.calls[2]?.[1]).toEqual([EVENT_ID]);
  });
});
