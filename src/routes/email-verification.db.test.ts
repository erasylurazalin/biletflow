import { createHash, randomUUID } from 'node:crypto';
import type { Express } from 'express';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

function tokenFromEmail(body: string): string {
  const match = body.match(/\/verify-email\?token=([A-Za-z0-9_-]+)/);
  expect(match).not.toBeNull();
  return match![1]!;
}

describe.skipIf(!TEST_DATABASE_URL)('email verification against a real database', () => {
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

  it('verifies a single-use link and gates organizer profile creation', async () => {
    const email = `${randomUUID()}@test.biletflow.kz`;
    const registered = await request(app)
      .post('/api/auth/register')
      .send({ email, password: 'test-password', name: 'Email Test Organizer' });
    expect(registered.status).toBe(201);
    expect(registered.body.user.email_verified).toBe(false);
    const userId = registered.body.user.id as string;
    const token = registered.body.token as string;
    const auth = { Authorization: `Bearer ${token}` };

    const me = await request(app).get('/api/auth/me').set(auth);
    expect(me.status).toBe(200);
    expect(me.body.user.email_verified).toBe(false);

    const profileBody = {
      display_name: 'Email Test Organizer',
      contact_email: email,
    };
    const unverifiedProfile = await request(app)
      .post('/api/me/organizer-profile')
      .set(auth)
      .send(profileBody);
    expect(unverifiedProfile.status).toBe(403);
    expect(unverifiedProfile.body.error.code).toBe('EMAIL_NOT_VERIFIED');

    const initialInbox = await request(app).get('/api/me/emails').set(auth);
    expect(initialInbox.status).toBe(200);
    expect(initialInbox.body.emails).toHaveLength(1);
    expect(initialInbox.body.emails[0]).toMatchObject({
      kind: 'verify_email',
      subject: 'Confirm your BiletFlow email',
    });
    const initialToken = tokenFromEmail(initialInbox.body.emails[0].body as string);

    const resent = await request(app).post('/api/auth/verify-email/resend').set(auth);
    expect(resent.status).toBe(200);
    expect(resent.body).toEqual({ sent: true });
    const resentInbox = await request(app).get('/api/me/emails').set(auth);
    expect(resentInbox.status).toBe(200);
    expect(resentInbox.body.emails).toHaveLength(2);
    const expiredToken = tokenFromEmail(resentInbox.body.emails[0].body as string);
    expect(expiredToken).not.toBe(initialToken);
    await pool.query(
      "UPDATE email_tokens SET expires_at = now() - interval '1 minute' WHERE token_hash = $1",
      [createHash('sha256').update(expiredToken).digest('hex')],
    );

    const expired = await request(app).post('/api/auth/verify-email').send({ token: expiredToken });
    expect(expired.status).toBe(400);
    expect(expired.body.error.code).toBe('INVALID_TOKEN');

    const verified = await request(app)
      .post('/api/auth/verify-email')
      .send({ token: initialToken });
    expect(verified.status).toBe(200);
    expect(verified.body.user).toMatchObject({ id: userId, email_verified: true });

    const reused = await request(app).post('/api/auth/verify-email').send({ token: initialToken });
    expect(reused.status).toBe(400);
    expect(reused.body.error.code).toBe('INVALID_TOKEN');

    const profile = await request(app)
      .post('/api/me/organizer-profile')
      .set(auth)
      .send(profileBody);
    expect(profile.status).toBe(201);
    expect(profile.body.user.role).toBe('organizer');
    expect(profile.body.token).toEqual(expect.any(String));
    expect(profile.body.token).not.toBe(token);
  });
});
