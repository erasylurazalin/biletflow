/**
 * Tests for the organizer profile endpoints. Same approach as ticket-types.test.ts: the
 * pool is faked, so validation and the JWT run for real but the SQL does not.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
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
import { signToken } from '../middleware/auth';

const query = vi.mocked(pool.query);
const app = createApp();

const USER_ID = '11111111-1111-4111-8111-111111111111';
const CREATED_AT = '2026-10-11T09:00:00.000Z';

const profileRow = {
  user_id: USER_ID,
  display_name: 'Astana Tech Community',
  contact_email: 'hello@astanatech.kz',
  contact_phone: '+77011234567',
  payout_bank_name: 'Demo Bank',
  payout_iban: 'KZ000000000000000000',
  payout_account_holder: 'Aidos K.',
  identity_verified_at: null,
  created_at: new Date(CREATED_AT),
  updated_at: new Date(CREATED_AT),
};

const profile = {
  user_id: USER_ID,
  display_name: 'Astana Tech Community',
  contact_email: 'hello@astanatech.kz',
  contact_phone: '+77011234567',
  payout: { bank_name: 'Demo Bank', iban: 'KZ000000000000000000', account_holder: 'Aidos K.' },
  identity_verified_at: null,
  created_at: CREATED_AT,
  updated_at: CREATED_AT,
};

const userAfter = { id: USER_ID, email: 'aidos@example.kz', name: 'Aidos', role: 'organizer' };

function rows(value: unknown[]) {
  return { rows: value } as never;
}

function bearer(role: 'attendee' | 'organizer' = 'attendee') {
  return `Bearer ${signToken({ id: USER_ID, role })}`;
}

beforeEach(() => {
  query.mockReset();
  process.env.JWT_SECRET = 'test-jwt-secret';
});

describe('POST /api/me/organizer-profile', () => {
  const body = {
    display_name: ' Astana Tech Community ',
    contact_email: 'Hello@AstanaTech.kz',
    contact_phone: '+7 (701) 123-45-67',
    payout: {
      bank_name: 'Demo Bank',
      iban: 'kz00 0000 0000 0000 0000',
      account_holder: 'Aidos K.',
    },
  };
  const verifiedUser = { email_verified_at: new Date('2026-10-24T10:00:00.000Z') };

  it('creates the profile, makes the user an organizer and returns a token saying so', async () => {
    query
      .mockResolvedValueOnce(rows([verifiedUser]))
      .mockResolvedValueOnce(rows([{ ...profileRow, ...userAfter }]));

    const res = await request(app)
      .post('/api/me/organizer-profile')
      .set('Authorization', bearer())
      .send(body);

    expect(res.status).toBe(201);
    expect(res.body.organizer_profile).toEqual(profile);
    expect(res.body.user).toEqual(userAfter);
    expect(jwt.decode(res.body.token)).toMatchObject({ id: USER_ID, role: 'organizer' });
    // Normalized before it reaches the database.
    expect(query.mock.calls[1]?.[1]).toEqual([
      USER_ID,
      'Astana Tech Community',
      'hello@astanatech.kz',
      '+77011234567',
      'Demo Bank',
      'KZ000000000000000000',
      'Aidos K.',
    ]);

    // The new token is accepted where an organizer is needed.
    query.mockResolvedValueOnce(rows([profileRow]));
    const me = await request(app)
      .get('/api/me/organizer-profile')
      .set('Authorization', `Bearer ${res.body.token}`);
    expect(me.status).toBe(200);
  });

  it('needs only a display name and one way to make contact', async () => {
    query.mockResolvedValueOnce(rows([verifiedUser])).mockResolvedValueOnce(
      rows([
        {
          ...profileRow,
          contact_email: null,
          payout_bank_name: null,
          payout_iban: null,
          payout_account_holder: null,
          ...userAfter,
        },
      ]),
    );

    const res = await request(app)
      .post('/api/me/organizer-profile')
      .set('Authorization', bearer())
      .send({ display_name: 'Astana Tech Community', contact_phone: '+77011234567' });

    expect(res.status).toBe(201);
    expect(res.body.organizer_profile.payout).toBeNull();
    expect(query.mock.calls[1]?.[1]).toEqual([
      USER_ID,
      'Astana Tech Community',
      null,
      '+77011234567',
      null,
      null,
      null,
    ]);
  });

  it('returns 403 when the email is not verified', async () => {
    query.mockResolvedValueOnce(rows([{ email_verified_at: null }]));

    const res = await request(app)
      .post('/api/me/organizer-profile')
      .set('Authorization', bearer())
      .send(body);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: {
        code: 'EMAIL_NOT_VERIFIED',
        message: 'Verify your email before creating an organizer profile',
      },
    });
    expect(query).toHaveBeenCalledOnce();
  });

  it('returns 409 when the user already has a profile', async () => {
    query
      .mockResolvedValueOnce(rows([verifiedUser]))
      .mockRejectedValueOnce(Object.assign(new Error('duplicate key'), { code: '23505' }));

    const res = await request(app)
      .post('/api/me/organizer-profile')
      .set('Authorization', bearer('organizer'))
      .send(body);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('returns 401 without a token', async () => {
    const res = await request(app).post('/api/me/organizer-profile').send(body);

    expect(res.status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing display name', { contact_email: 'a@b.kz' }],
    ['a blank display name', { display_name: '   ', contact_email: 'a@b.kz' }],
    ['no contact at all', { display_name: 'X' }],
    ['both contacts null', { display_name: 'X', contact_email: null, contact_phone: null }],
    ['a contact email that is not an email', { display_name: 'X', contact_email: 'nope' }],
    ['a phone without a country code', { display_name: 'X', contact_phone: '87011234567' }],
    ['a phone with letters', { display_name: 'X', contact_phone: '+7 701 CALL ME' }],
    [
      'a payout without an IBAN',
      { ...body, payout: { bank_name: 'Demo Bank', account_holder: 'Aidos K.' } },
    ],
    ['a payout IBAN that is not an IBAN', { ...body, payout: { ...body.payout, iban: '1234' } }],
  ])('returns 400 for %s, without touching the database', async (_label, invalid) => {
    const res = await request(app)
      .post('/api/me/organizer-profile')
      .set('Authorization', bearer())
      .send(invalid);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(query).not.toHaveBeenCalled();
  });
});

describe('GET /api/me/organizer-profile', () => {
  it('returns my profile', async () => {
    query.mockResolvedValueOnce(rows([profileRow]));

    const res = await request(app)
      .get('/api/me/organizer-profile')
      .set('Authorization', bearer('organizer'));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ organizer_profile: profile });
    expect(query.mock.calls[0]?.[1]).toEqual([USER_ID]);
  });

  it('returns 404 ORGANIZER_PROFILE_NOT_FOUND when I have none', async () => {
    query.mockResolvedValueOnce(rows([]));

    const res = await request(app).get('/api/me/organizer-profile').set('Authorization', bearer());

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ORGANIZER_PROFILE_NOT_FOUND');
  });
});

describe('PATCH /api/me/organizer-profile', () => {
  it('changes only the fields sent and keeps the rest', async () => {
    query
      .mockResolvedValueOnce(rows([profileRow]))
      .mockResolvedValueOnce(rows([{ ...profileRow, display_name: 'Astana Tech' }]));

    const res = await request(app)
      .patch('/api/me/organizer-profile')
      .set('Authorization', bearer('organizer'))
      .send({ display_name: 'Astana Tech' });

    expect(res.status).toBe(200);
    expect(res.body.organizer_profile).toEqual({ ...profile, display_name: 'Astana Tech' });
    expect(query.mock.calls[1]?.[1]).toEqual([
      USER_ID,
      'Astana Tech',
      'hello@astanatech.kz',
      '+77011234567',
      'Demo Bank',
      'KZ000000000000000000',
      'Aidos K.',
    ]);
  });

  it('removes the payout account with payout: null', async () => {
    query
      .mockResolvedValueOnce(rows([profileRow]))
      .mockResolvedValueOnce(
        rows([
          { ...profileRow, payout_bank_name: null, payout_iban: null, payout_account_holder: null },
        ]),
      );

    const res = await request(app)
      .patch('/api/me/organizer-profile')
      .set('Authorization', bearer('organizer'))
      .send({ payout: null });

    expect(res.status).toBe(200);
    expect(res.body.organizer_profile.payout).toBeNull();
    expect(query.mock.calls[1]?.[1]).toEqual([
      USER_ID,
      'Astana Tech Community',
      'hello@astanatech.kz',
      '+77011234567',
      null,
      null,
      null,
    ]);
  });

  it('returns 400 when the change would leave no way to make contact', async () => {
    query.mockResolvedValueOnce(rows([{ ...profileRow, contact_email: null }]));

    const res = await request(app)
      .patch('/api/me/organizer-profile')
      .set('Authorization', bearer('organizer'))
      .send({ contact_phone: null });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['an empty body', {}],
    ['a blank display name', { display_name: '' }],
    ['a bad phone', { contact_phone: 'call me' }],
  ])('returns 400 for %s, without touching the database', async (_label, invalid) => {
    const res = await request(app)
      .patch('/api/me/organizer-profile')
      .set('Authorization', bearer('organizer'))
      .send(invalid);

    expect(res.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it('returns 404 when I have no profile to edit', async () => {
    query.mockResolvedValueOnce(rows([]));

    const res = await request(app)
      .patch('/api/me/organizer-profile')
      .set('Authorization', bearer())
      .send({ display_name: 'X' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ORGANIZER_PROFILE_NOT_FOUND');
  });
});

describe('POST /api/me/organizer-profile/verify-identity', () => {
  it('records the simulated identity check and its audit entry', async () => {
    const VERIFIED_AT = '2026-10-13T12:00:00.000Z';
    const PROFILE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    query
      .mockResolvedValueOnce(
        rows([
          {
            ...profileRow,
            identity_verified_at: new Date(VERIFIED_AT),
            organizer_profile_id: PROFILE_ID,
          },
        ]),
      )
      .mockResolvedValueOnce(rows([]));

    const res = await request(app)
      .post('/api/me/organizer-profile/verify-identity')
      .set('Authorization', bearer('organizer'));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      organizer_profile: { ...profile, identity_verified_at: VERIFIED_AT },
    });
    expect(String(query.mock.calls[0]?.[0])).toContain('p.identity_verified_at IS NULL');
    expect(String(query.mock.calls[1]?.[0])).toContain('INSERT INTO audit_log');
    expect(query.mock.calls[1]?.[1]).toEqual([
      USER_ID,
      'organizer_profile.identity_verified',
      'organizer_profile',
      PROFILE_ID,
      null,
      'Completed the simulated organizer identity check',
    ]);
  });

  it('does not write another audit entry when identity is already verified', async () => {
    query
      .mockResolvedValueOnce(rows([]))
      .mockResolvedValueOnce(rows([{ ...profileRow, identity_verified_at: new Date() }]));

    const res = await request(app)
      .post('/api/me/organizer-profile/verify-identity')
      .set('Authorization', bearer('organizer'));

    expect(res.status).toBe(200);
    expect(query).toHaveBeenCalledTimes(2);
    expect(String(query.mock.calls[0]?.[0])).not.toContain('INSERT INTO audit_log');
  });

  it('returns 404 without a profile and writes no audit entry', async () => {
    query.mockResolvedValueOnce(rows([])).mockResolvedValueOnce(rows([]));

    const res = await request(app)
      .post('/api/me/organizer-profile/verify-identity')
      .set('Authorization', bearer());

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ORGANIZER_PROFILE_NOT_FOUND');
    expect(query.mock.calls.some((call) => String(call[0]).includes('INSERT INTO audit_log'))).toBe(
      false,
    );
  });

  it('returns 401 without a token', async () => {
    const res = await request(app).post('/api/me/organizer-profile/verify-identity');

    expect(res.status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('GET /api/me/emails', () => {
  it("returns the caller's simulated inbox newest first", async () => {
    const createdAt = new Date('2026-10-24T10:00:00.000Z');
    query.mockResolvedValueOnce(
      rows([
        {
          id: '22222222-2222-4222-8222-222222222222',
          kind: 'verify_email',
          subject: 'Confirm your BiletFlow email',
          body: 'http://localhost:3001/verify-email?token=secret',
          created_at: createdAt,
        },
      ]),
    );

    const res = await request(app).get('/api/me/emails').set('Authorization', bearer());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      emails: [
        {
          id: '22222222-2222-4222-8222-222222222222',
          kind: 'verify_email',
          subject: 'Confirm your BiletFlow email',
          body: 'http://localhost:3001/verify-email?token=secret',
          created_at: createdAt.toISOString(),
        },
      ],
    });
    expect(query.mock.calls[0]?.[1]).toEqual([USER_ID]);
    expect(String(query.mock.calls[0]?.[0])).toContain('lower(u.email) = lower(e.to_email)');
    expect(String(query.mock.calls[0]?.[0])).toContain('ORDER BY e.created_at DESC');
    expect(String(query.mock.calls[0]?.[0])).toContain('LIMIT 50');
  });
});
