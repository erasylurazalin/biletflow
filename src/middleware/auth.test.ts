import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { requireAuth } from './auth';
import { AppError } from '../lib/errors';

describe('requireAuth middleware', () => {
  const secret = 'test-jwt-secret';

  beforeEach(() => {
    process.env.JWT_SECRET = secret;
  });

  const mockReq = (authHeader?: string) =>
    ({
      header: (name: string) => (name.toLowerCase() === 'authorization' ? authHeader : undefined),
    }) as Request;

  const mockRes = {} as Response;
  const mockNext = vi.fn() as NextFunction;

  it('throws unauthorized error if authorization header is missing', () => {
    const req = mockReq();
    expect(() => requireAuth(req, mockRes, mockNext)).toThrow(AppError);
  });

  it('throws unauthorized error if token is malformed or invalid', () => {
    const req = mockReq('Bearer invalid-token');
    expect(() => requireAuth(req, mockRes, mockNext)).toThrow(AppError);
  });

  it('attaches user payload to req.user and calls next() on valid token', () => {
    const payload = { id: '00000000-0000-0000-0000-000000000000', role: 'attendee' as const };
    const token = jwt.sign(payload, secret);
    const req = mockReq(`Bearer ${token}`);

    requireAuth(req, mockRes, mockNext);

    expect(req.user).toEqual(payload);
    expect(mockNext).toHaveBeenCalledOnce();
  });
});
