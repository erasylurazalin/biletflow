/**
 * STUB. Not implemented yet.
 *
 * Owner: whoever took the auth task (register, login, password hashing, JWT signing).
 * Do not fill this in if it is not your task, and do not work around it by reading the
 * header yourself inside a route.
 *
 * The shape below is the contract the rest of the code already assumes:
 *
 *   app.get('/api/orders', requireAuth, async (req, res) => {
 *     req.user  // { id, role }, guaranteed present after requireAuth
 *   });
 *
 * What is left to do here:
 *   1. verify the token with jsonwebtoken and process.env.JWT_SECRET
 *   2. put the payload on req.user
 *   3. throw AppError.unauthorized(...) for a missing, malformed or expired token
 * The header parsing is already written, so start at the TODO.
 */
import type { NextFunction, Request, Response } from 'express';
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

export function requireAuth(req: Request, _res: Response, _next: NextFunction): void {
  const header = req.header('authorization');

  if (!header?.startsWith('Bearer ')) {
    throw AppError.unauthorized('Missing Bearer token');
  }

  const token = header.slice('Bearer '.length).trim();
  if (!token) {
    throw AppError.unauthorized('Missing Bearer token');
  }

  // TODO(auth owner): verify `token`, set req.user = { id, role }, then call next().
  throw new AppError(ErrorCode.NOT_IMPLEMENTED, 'Authentication is not implemented yet', 501);
}
