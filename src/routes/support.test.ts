/**
 * Validation tests for the support case routes with the pool faked. The access rules
 * and the real SQL need a database and live in support.db.test.ts.
 *
 * Every test here sends something the Zod schema refuses, so the route must answer 400
 * before it opens a transaction or asks the pool anything.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../db/pool', () => {
  const query = vi.fn();
  return { pool: { query, connect: vi.fn(async () => ({ query, release: vi.fn() })) } };
});

import { pool } from '../db/pool';
import { createApp } from '../app';
import { signToken } from '../middleware/auth';

const query = vi.mocked(pool.query);
const app = createApp();

const USER_ID = '22222222-2222-4222-8222-222222222222';
const EVENT_ID = '33333333-3333-4333-8333-333333333333';

function bearer() {
  return `Bearer ${signToken({ id: USER_ID, role: 'attendee' })}`;
}

beforeEach(() => {
  query.mockReset();
  process.env.JWT_SECRET = 'test-jwt-secret';
});

function openCase(overrides: Record<string, unknown> = {}) {
  return request(app)
    .post('/api/support/cases')
    .set('Authorization', bearer())
    .send({
      kind: 'event',
      event_id: EVENT_ID,
      category: 'ticket_delivery',
      subject: 'Where is my ticket?',
      body: 'I paid but the ticket did not arrive.',
      ...overrides,
    });
}

describe('POST /api/support/cases validation', () => {
  it('rejects an unknown category', async () => {
    const res = await openCase({ category: 'lost_luggage' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toContain('category');
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects an empty body', async () => {
    const res = await openCase({ body: '   ' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toContain('body');
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects a subject longer than 200 characters', async () => {
    const res = await openCase({ subject: 'x'.repeat(201) });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toContain('subject');
    expect(query).not.toHaveBeenCalled();
  });

  it('needs an event id for an event case', async () => {
    const res = await openCase({ event_id: undefined });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toContain('event_id');
    expect(query).not.toHaveBeenCalled();
  });

  it('refuses event context on a platform case', async () => {
    const res = await openCase({ kind: 'platform', event_id: EVENT_ID });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(query).not.toHaveBeenCalled();
  });

  it('requires a token before validating anything', async () => {
    const res = await request(app).post('/api/support/cases').send({});

    expect(res.status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('POST /api/support/cases/:id/messages validation', () => {
  it('rejects a message over 5000 characters', async () => {
    const res = await request(app)
      .post(`/api/support/cases/${EVENT_ID}/messages`)
      .set('Authorization', bearer())
      .send({ body: 'x'.repeat(5001) });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(query).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/support/cases/:id validation', () => {
  it('requires at least one field', async () => {
    const res = await request(app)
      .patch(`/api/support/cases/${EVENT_ID}`)
      .set('Authorization', bearer())
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects an unknown status', async () => {
    const res = await request(app)
      .patch(`/api/support/cases/${EVENT_ID}`)
      .set('Authorization', bearer())
      .send({ status: 'closed' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toContain('status');
    expect(query).not.toHaveBeenCalled();
  });
});
