import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { requireAuth } from './auth';
import { AppError } from '../lib/errors';

describe('requireAuth middleware', () => {
  const secret = 'test-jwt-secret';
  const validPayload = { id: '00000000-0000-0000-0000-000000000000', role: 'attendee' as const };

  beforeEach(() => {
    process.env.JWT_SECRET = secret;
  });

  const mockReq = (authHeader?: string) =>
    ({
      header: (name: string) => (name.toLowerCase() === 'authorization' ? authHeader : undefined),
    }) as Request;

  const mockRes = {} as Response;
  const mockNext = vi.fn() as NextFunction;

  // Runs requireAuth with the given token and asserts it was rejected as a 401.
  function expectUnauthorized(token?: string) {
    const req = mockReq(token === undefined ? undefined : `Bearer ${token}`);
    let thrown: unknown;
    try {
      requireAuth(req, mockRes, mockNext);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).httpStatus).toBe(401);
    expect(req.user).toBeUndefined();
  }

  beforeEach(() => {
    vi.mocked(mockNext).mockClear();
  });

  it('rejects a missing authorization header with 401', () => {
    expectUnauthorized();
  });

  it('rejects a malformed token with 401', () => {
    expectUnauthorized('invalid-token');
  });

  it('rejects an unknown role with 401', () => {
    expectUnauthorized(jwt.sign({ ...validPayload, role: 'superuser' }, secret));
  });

  it('rejects a non-uuid id with 401', () => {
    expectUnauthorized(jwt.sign({ ...validPayload, id: '42' }, secret));
  });

  it('rejects an expired token with 401', () => {
    expectUnauthorized(jwt.sign(validPayload, secret, { expiresIn: -10 }));
  });

  it('rejects a token signed with a different secret with 401', () => {
    expectUnauthorized(jwt.sign(validPayload, 'some-other-secret'));
  });

  it('rejects a token signed with an algorithm other than HS256 with 401', () => {
    expectUnauthorized(jwt.sign(validPayload, secret, { algorithm: 'HS512' }));
  });

  it('attaches only id and role to req.user and calls next() on a valid token', () => {
    const token = jwt.sign(validPayload, secret, { expiresIn: '1h' });
    const req = mockReq(`Bearer ${token}`);

    requireAuth(req, mockRes, mockNext);

    // iat and exp are stripped by the schema.
    expect(req.user).toEqual(validPayload);
    expect(mockNext).toHaveBeenCalledOnce();
  });
});
