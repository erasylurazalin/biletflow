/**
 * A user who forgot their password cannot log in to read the simulated inbox, so the
 * demo outbox is public outside production. It is disabled in production because it
 * would otherwise show anyone's emails.
 */
import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool';
import { AppError, ErrorCode } from '../lib/errors';

export const devRouter = Router();

const emailSchema = z.string().trim().toLowerCase().pipe(z.email());

devRouter.get('/dev/outbox', async (req, res, next) => {
  try {
    if (process.env.NODE_ENV === 'production') {
      throw AppError.notFound(ErrorCode.NOT_FOUND, 'Not found');
    }

    const parsed = emailSchema.safeParse(req.query.email);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw AppError.badRequest(
        first ? `Invalid field "email": ${first.message}` : 'Invalid field "email": Invalid email',
      );
    }

    const result = await pool.query(
      `SELECT e.id, e.kind, e.subject, e.body, e.created_at
         FROM email_outbox e
        WHERE lower(e.to_email) = $1
        ORDER BY e.created_at DESC
        LIMIT 50`,
      [parsed.data],
    );
    res.json({ emails: result.rows });
  } catch (err) {
    next(err);
  }
});
