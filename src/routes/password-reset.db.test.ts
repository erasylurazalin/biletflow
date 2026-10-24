import { createHash, randomUUID } from 'node:crypto';
import type { Express } from 'express';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

function tokenFromEmail(body: string): string {
  const match = body.match(/\/reset-password\?token=([A-Za-z0-9_-]+)/);
  expect(match).not.toBeNull();
  return match![1]!;
}

async function requestReset(app: Express, email: string): Promise<string> {
  const response = await request(app).post('/api/auth/password-reset/request').send({ email });
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ sent: true });

  const outbox = await request(app).get('/api/dev/outbox').query({ email });
  expect(outbox.status).toBe(200);
  expect(outbox.body.emails[0]).toMatchObject({
    kind: 'reset_password',
    subject: 'Reset your BiletFlow password',
  });
  return tokenFromEmail(outbox.body.emails[0].body as string);
}

describe.skipIf(!TEST_DATABASE_URL)('password reset against a real database', () => {
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

  it('resets a password and expires, consumes and supersedes reset links', async () => {
    const email = `${randomUUID()}@test.biletflow.kz`;
    const oldPassword = 'old-test-password';
    const newPassword = 'new-test-password';
    const registered = await request(app)
      .post('/api/auth/register')
      .send({ email, password: oldPassword, name: 'Password Reset Test' });
    expect(registered.status).toBe(201);

    const token = await requestReset(app, email);
    const confirmed = await request(app)
      .post('/api/auth/password-reset/confirm')
      .send({ token, password: newPassword });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.user).toMatchObject({ email, email_verified: true });
    expect(confirmed.body.token).toEqual(expect.any(String));

    const oldLogin = await request(app)
      .post('/api/auth/login')
      .send({ email, password: oldPassword });
    expect(oldLogin.status).toBe(401);
    const newLogin = await request(app)
      .post('/api/auth/login')
      .send({ email, password: newPassword });
    expect(newLogin.status).toBe(200);
    expect(newLogin.body.user.email).toBe(email);

    const reused = await request(app)
      .post('/api/auth/password-reset/confirm')
      .send({ token, password: 'another-test-password' });
    expect(reused.status).toBe(400);
    expect(reused.body.error.code).toBe('INVALID_TOKEN');

    const expiredToken = await requestReset(app, email);
    await pool.query(
      "UPDATE email_tokens SET expires_at = now() - interval '1 minute' WHERE token_hash = $1",
      [createHash('sha256').update(expiredToken).digest('hex')],
    );
    const expired = await request(app)
      .post('/api/auth/password-reset/confirm')
      .send({ token: expiredToken, password: 'another-test-password' });
    expect(expired.status).toBe(400);
    expect(expired.body.error.code).toBe('INVALID_TOKEN');

    const firstToken = await requestReset(app, email);
    const secondToken = await requestReset(app, email);
    expect(secondToken).not.toBe(firstToken);
    const secondConfirmation = await request(app)
      .post('/api/auth/password-reset/confirm')
      .send({ token: secondToken, password: 'latest-test-password' });
    expect(secondConfirmation.status).toBe(200);
    const superseded = await request(app)
      .post('/api/auth/password-reset/confirm')
      .send({ token: firstToken, password: 'another-test-password' });
    expect(superseded.status).toBe(400);
    expect(superseded.body.error.code).toBe('INVALID_TOKEN');
  });
});
