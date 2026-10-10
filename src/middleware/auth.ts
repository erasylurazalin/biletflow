/**
 * Verifies the Bearer JWT and puts { id, role } on req.user. signToken() issues the
 * token for register/login in routes/auth.ts.
 *
 * Use it on any route that needs a logged-in user, and do not read the header yourself
 * inside a route:
 *
 *   app.get('/api/orders', requireAuth, async (req, res) => {
 *     req.user  // { id, role }, guaranteed present after requireAuth
 *   });
 *
 * A missing, malformed, expired or wrongly signed token is a 401.
 */
import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { AppError, ErrorCode } from '../lib/errors';

// What a valid token must carry. A correct signature only proves we issued the token,
// so the contents are still checked: an unknown role or a non-uuid id is a 401, never
// a req.user the routes trust. Extra claims (iat, exp) are stripped.
const tokenPayloadSchema = z.object({
  id: z.uuid(),
  role: z.enum(['attendee', 'organizer', 'event_admin', 'platform_admin']),
});

export type AuthUser = z.infer<typeof tokenPayloadSchema>;

// Teaches TypeScript that req.user exists. Optional, because on public routes such as
// GET /api/events nobody has attached it.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

// How long a login lasts. There are no refresh tokens yet, so after this the user logs
// in again.
const TOKEN_EXPIRES_IN = '7d';

function getSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new AppError(ErrorCode.INTERNAL_ERROR, 'JWT_SECRET configuration is missing', 500);
  }
  return secret;
}

export function signToken(user: AuthUser): string {
  return jwt.sign({ id: user.id, role: user.role }, getSecret(), {
    expiresIn: TOKEN_EXPIRES_IN,
  });
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.header('authorization');

  if (!header?.startsWith('Bearer ')) {
    throw AppError.unauthorized('Missing Bearer token');
  }

  const token = header.slice('Bearer '.length).trim();
  if (!token) {
    throw AppError.unauthorized('Missing Bearer token');
  }

  const secret = getSecret();

  let decoded: unknown;
  try {
    // Pinning the algorithm stops a token from choosing how it gets verified.
    decoded = jwt.verify(token, secret, { algorithms: ['HS256'] });
  } catch {
    throw AppError.unauthorized('Invalid or expired token');
  }

  const parsed = tokenPayloadSchema.safeParse(decoded);
  if (!parsed.success) {
    throw AppError.unauthorized('Invalid token payload');
  }

  req.user = parsed.data;
  next();
}
