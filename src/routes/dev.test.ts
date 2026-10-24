import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../db/pool', () => ({ pool: { query: vi.fn() } }));

import { pool } from '../db/pool';
import { createApp } from '../app';

const query = vi.mocked(pool.query);
const app = createApp();
const originalNodeEnv = process.env.NODE_ENV;

beforeEach(() => {
  query.mockReset();
  process.env.NODE_ENV = 'test';
});

afterEach(() => {
  process.env.NODE_ENV = originalNodeEnv;
});

describe('GET /api/dev/outbox', () => {
  it('returns 404 in production without touching the database', async () => {
    process.env.NODE_ENV = 'production';

    const res = await request(app).get('/api/dev/outbox?email=aidos@example.kz');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: 'Not found' } });
    expect(query).not.toHaveBeenCalled();
  });

  it('returns 400 without an email', async () => {
    const res = await request(app).get('/api/dev/outbox');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(query).not.toHaveBeenCalled();
  });

  it('returns emails for the address newest first', async () => {
    const createdAt = new Date('2026-10-25T10:00:00.000Z');
    query.mockResolvedValueOnce({
      rows: [
        {
          id: '22222222-2222-4222-8222-222222222222',
          kind: 'reset_password',
          subject: 'Reset your BiletFlow password',
          body: 'http://localhost:3001/reset-password?token=secret',
          created_at: createdAt,
        },
      ],
    } as never);

    const res = await request(app).get('/api/dev/outbox?email= AIDOS@example.kz ');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      emails: [
        {
          id: '22222222-2222-4222-8222-222222222222',
          kind: 'reset_password',
          subject: 'Reset your BiletFlow password',
          body: 'http://localhost:3001/reset-password?token=secret',
          created_at: createdAt.toISOString(),
        },
      ],
    });
    expect(query.mock.calls[0]?.[1]).toEqual(['aidos@example.kz']);
    expect(String(query.mock.calls[0]?.[0])).toContain('lower(e.to_email) = $1');
    expect(String(query.mock.calls[0]?.[0])).toContain('ORDER BY e.created_at DESC');
    expect(String(query.mock.calls[0]?.[0])).toContain('LIMIT 50');
  });
});
