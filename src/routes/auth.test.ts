/**
 * Tests for the auth endpoints. Same approach as events.test.ts: the pool is faked, so
 * bcrypt and JWT run for real but the SQL does not.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

vi.mock('../db/pool', () => ({ pool: { query: vi.fn() } }));

import { pool } from '../db/pool';
import { createApp } from '../app';

const query = vi.mocked(pool.query);
const app = createApp();

const userRow = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'aidos@example.kz',
  name: 'Aidos',
  role: 'attendee',
};

function rows(value: unknown[]) {
  return { rows: value } as never;
}

beforeEach(() => {
  query.mockReset();
  process.env.JWT_SECRET = 'test-jwt-secret';
});

describe('POST /api/auth/register', () => {
  it('creates the user with a bcrypt hash and returns a token that works on /me', async () => {
    query.mockResolvedValueOnce(rows([userRow]));

    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: '  Aidos@Example.KZ ', password: 'correct-horse', name: 'Aidos' });

    expect(res.status).toBe(201);
    expect(res.body.user).toEqual(userRow);
    expect(res.body.user.password_hash).toBeUndefined();

    const [email, hash, name] = query.mock.calls[0]?.[1] as unknown as [string, string, string];
    expect(email).toBe('aidos@example.kz');
    expect(name).toBe('Aidos');
    expect(hash).not.toBe('correct-horse');
    expect(await bcrypt.compare('correct-horse', hash)).toBe(true);

    // The token expires, and it is accepted by requireAuth.
    const decoded = jwt.decode(res.body.token) as { id: string; role: string; exp?: number };
    expect(decoded).toMatchObject({ id: userRow.id, role: 'attendee' });
    expect(decoded.exp).toBeGreaterThan(Date.now() / 1000);

    query.mockResolvedValueOnce(rows([userRow]));
    const me = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${res.body.token}`);
    expect(me.status).toBe(200);
    expect(me.body).toEqual({ user: userRow });
    expect(query.mock.calls[1]?.[1]).toEqual([userRow.id]);
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
    expect(res.body.user).toEqual(userRow);
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
