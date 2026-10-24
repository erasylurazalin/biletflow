/**
 * Tests for the auth endpoints. Same approach as events.test.ts: the pool is faked, so
 * bcrypt and JWT run for real but the SQL does not.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

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

import { pool } from '../db/pool';
import { createApp } from '../app';

const query = vi.mocked(pool.query);
const app = createApp();

const userRow = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'aidos@example.kz',
  name: 'Aidos',
  role: 'attendee',
  email_verified_at: null,
};
const publicUser = {
  id: userRow.id,
  email: userRow.email,
  name: userRow.name,
  role: userRow.role,
  email_verified: false,
};

function rows(value: unknown[]) {
  return { rows: value } as never;
}

beforeEach(() => {
  query.mockReset();
  process.env.JWT_SECRET = 'test-jwt-secret';
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /api/auth/register', () => {
  it('creates the user, sends a verification email and returns a token that works on /me', async () => {
    query.mockResolvedValueOnce(rows([userRow]));

    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: '  Aidos@Example.KZ ', password: 'correct-horse', name: 'Aidos' });

    expect(res.status).toBe(201);
    expect(res.body.user).toEqual(publicUser);
    expect(res.body.user.password_hash).toBeUndefined();

    const [email, hash, name] = query.mock.calls[0]?.[1] as unknown as [string, string, string];
    expect(email).toBe('aidos@example.kz');
    expect(name).toBe('Aidos');
    expect(hash).not.toBe('correct-horse');
    expect(await bcrypt.compare('correct-horse', hash)).toBe(true);

    expect(String(query.mock.calls[1]?.[0])).toContain('INSERT INTO email_tokens');
    expect(query.mock.calls[1]?.[1]?.[0]).toBe(userRow.id);
    expect(query.mock.calls[1]?.[1]?.[1]).toBe('verify_email');
    expect(query.mock.calls[1]?.[1]?.[3]).toBe(24 * 60);
    expect(String(query.mock.calls[2]?.[0])).toContain('INSERT INTO email_outbox');
    const outboxParams = query.mock.calls[2]?.[1] as unknown as string[];
    expect(outboxParams.slice(0, 4)).toEqual([
      userRow.id,
      userRow.email,
      'verify_email',
      'Confirm your BiletFlow email',
    ]);
    expect(outboxParams[4]).toContain('http://localhost:3001/verify-email?token=');

    // The token expires, and it is accepted by requireAuth.
    const decoded = jwt.decode(res.body.token) as { id: string; role: string; exp?: number };
    expect(decoded).toMatchObject({ id: userRow.id, role: 'attendee' });
    expect(decoded.exp).toBeGreaterThan(Date.now() / 1000);

    query.mockResolvedValueOnce(rows([userRow]));
    const me = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${res.body.token}`);
    expect(me.status).toBe(200);
    expect(me.body).toEqual({ user: publicUser });
    expect(query.mock.calls[3]?.[1]).toEqual([userRow.id]);
  });

  it('returns 409 when the email is already registered', async () => {
    query.mockRejectedValueOnce(Object.assign(new Error('duplicate key'), { code: '23505' }));

    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'aidos@example.kz', password: 'correct-horse', name: 'Aidos' });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: { code: 'CONFLICT', message: 'An account with this email already exists' },
    });
  });

  it('rejects a short password without touching the database', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'aidos@example.kz', password: 'short', name: 'Aidos' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects an invalid email', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'not-an-email', password: 'correct-horse', name: 'Aidos' });

    expect(res.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('POST /api/auth/login', () => {
  const storedRow = { ...userRow, password_hash: bcrypt.hashSync('correct-horse', 4) };

  it('returns the user and a token for the right password', async () => {
    query.mockResolvedValueOnce(rows([storedRow]));

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'AIDOS@example.kz', password: 'correct-horse' });

    expect(res.status).toBe(200);
    expect(res.body.user).toEqual(publicUser);
    expect(query.mock.calls[0]?.[1]).toEqual(['aidos@example.kz']);
    expect(jwt.verify(res.body.token, 'test-jwt-secret')).toMatchObject({ id: userRow.id });
  });

  it('returns 401 for a wrong password', async () => {
    query.mockResolvedValueOnce(rows([storedRow]));

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'aidos@example.kz', password: 'wrong-password' });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      error: { code: 'UNAUTHORIZED', message: 'Email or password is incorrect' },
    });
    expect(res.body.token).toBeUndefined();
  });

  it('returns the same 401 for an unknown email', async () => {
    query.mockResolvedValueOnce(rows([]));

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@example.kz', password: 'correct-horse' });

    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('Email or password is incorrect');
  });

  it('still runs bcrypt for an unknown email, so timing does not reveal accounts', async () => {
    query.mockResolvedValueOnce(rows([]));
    const compare = vi.spyOn(bcrypt, 'compare');

    await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@example.kz', password: 'correct-horse' });

    expect(compare).toHaveBeenCalledOnce();
    compare.mockRestore();
  });
});

describe('POST /api/auth/verify-email', () => {
  it('returns 400 INVALID_TOKEN for a bad token', async () => {
    query.mockResolvedValueOnce(rows([]));

    const res = await request(app).post('/api/auth/verify-email').send({ token: 'bad-token' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: { code: 'INVALID_TOKEN', message: 'This link is invalid or has expired' },
    });
    expect(query).toHaveBeenCalledOnce();
  });

  it('verifies the user for a good token', async () => {
    const verifiedAt = new Date('2026-10-24T10:00:00.000Z');
    query
      .mockResolvedValueOnce(rows([{ user_id: userRow.id }]))
      .mockResolvedValueOnce(rows([{ ...userRow, email_verified_at: verifiedAt }]));

    const res = await request(app).post('/api/auth/verify-email').send({ token: 'good-token' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ user: { ...publicUser, email_verified: true } });
    expect(query.mock.calls[1]?.[1]).toEqual([userRow.id]);
    expect(String(query.mock.calls[1]?.[0])).toContain('COALESCE(email_verified_at, now())');
  });
});

describe('POST /api/auth/verify-email/resend', () => {
  it('returns 409 when the email is already verified', async () => {
    query.mockResolvedValueOnce(
      rows([{ ...userRow, email_verified_at: new Date('2026-10-24T10:00:00.000Z') }]),
    );
    const token = jwt.sign({ id: userRow.id, role: userRow.role }, 'test-jwt-secret', {
      expiresIn: '1h',
    });

    const res = await request(app)
      .post('/api/auth/verify-email/resend')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: { code: 'CONFLICT', message: 'Your email is already verified' },
    });
    expect(query).toHaveBeenCalledOnce();
  });
});

describe('GET /api/auth/me', () => {
  it('returns 401 without a token', async () => {
    const res = await request(app).get('/api/auth/me');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(query).not.toHaveBeenCalled();
  });

  it('returns 401 for an expired token', async () => {
    const token = jwt.sign({ id: userRow.id, role: 'attendee' }, 'test-jwt-secret', {
      expiresIn: -10,
    });

    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });
});
