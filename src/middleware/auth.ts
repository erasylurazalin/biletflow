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
import { AppError, ErrorCode } from '../lib/errors';

export interface AuthUser {
  id: string;
  role: 'attendee' | 'organizer' | 'event_admin' | 'platform_admin';
}

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

  try {
    // TODO: validate the payload with Zod (uuid id, one of the four roles). The cast
    // below only tells TypeScript to trust it, nothing is checked at runtime.
    const payload = jwt.verify(token, secret) as AuthUser;

    if (!payload.id || !payload.role) {
      throw AppError.unauthorized('Invalid token payload');
    }

    req.user = {
      id: payload.id,
      role: payload.role,
    };

    next();
  } catch (err) {
    if (err instanceof AppError) {
      throw err;
    }
    throw AppError.unauthorized('Invalid or expired token');
  }
}
