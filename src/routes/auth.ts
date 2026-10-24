/**
 * Auth endpoints: register, login, me and email verification. Same layering as
 * routes/events.ts.
 *
 * Passwords are hashed with bcrypt (bcryptjs: same algorithm, no native build step on
 * Windows). The token is a JWT carrying { id, role }, signed and verified in
 * middleware/auth.ts.
 */
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { pool } from '../db/pool';
import { withTransaction } from '../db/transaction';
import { createEmailToken, consumeEmailToken } from '../lib/email-tokens';
import { AppError, ErrorCode } from '../lib/errors';
import { sendEmail, webUrl } from '../lib/mailer';
import { requireAuth, signToken, type AuthUser } from '../middleware/auth';

export const authRouter = Router();

// 10 rounds is ~50-100ms per hash: slow for an attacker, unnoticeable for a person.
const BCRYPT_ROUNDS = 10;
const VERIFY_EMAIL_TTL_MINUTES = 24 * 60;
const RESET_PASSWORD_TTL_MINUTES = 60;

// Compared against when login finds no user, so an unknown email costs the same bcrypt
// time as a wrong password and response timing does not reveal who has an account.
// Same rounds as real hashes, or the timing would still differ.
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', BCRYPT_ROUNDS);

// Postgres error code for a unique constraint violation.
const PG_UNIQUE_VIOLATION = '23505';

interface UserRow {
  id: string;
  email: string;
  name: string;
  role: AuthUser['role'];
  email_verified_at: Date | null;
}

// docs/api.md "user" object. password_hash must never leave this file.
function toUser(row: UserRow) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    email_verified: row.email_verified_at !== null,
  };
}

function badRequestFrom(error: z.ZodError): AppError {
  const first = error.issues[0];
  return AppError.badRequest(
    first ? `Invalid field "${first.path.join('.')}": ${first.message}` : 'Invalid request body',
  );
}

// Emails are stored and compared lower-cased (see users_email_lower_idx).
const emailSchema = z.string().trim().toLowerCase().pipe(z.email());

async function sendVerificationEmail(client: PoolClient, user: UserRow): Promise<void> {
  const token = await createEmailToken(client, user.id, 'verify_email', VERIFY_EMAIL_TTL_MINUTES);
  const link = `${webUrl()}/verify-email?token=${token}`;
  await sendEmail(client, {
    userId: user.id,
    to: user.email,
    kind: 'verify_email',
    subject: 'Confirm your BiletFlow email',
    body: `Confirm your BiletFlow email by opening this link:\n\n${link}\n\nThis link is valid for 24 hours.`,
  });
}

// ---------------------------------------------------------------------------
// POST /api/auth/register
// ---------------------------------------------------------------------------

// bcrypt ignores everything after 72 bytes, so refuse longer passwords rather than
// silently accepting a password that only partly counts.
const passwordSchema = z
  .string()
  .min(8)
  .refine((p) => Buffer.byteLength(p) <= 72, 'Password must be at most 72 bytes');

const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  name: z.string().trim().min(1).max(100),
});

authRouter.post('/register', async (req, res, next) => {
  try {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequestFrom(parsed.error);
    }
    const { email, password, name } = parsed.data;

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    const user = await withTransaction(async (client) => {
      let inserted: UserRow | undefined;
      try {
        // No "SELECT first, then INSERT": two requests could both pass the check. The
        // unique index decides, and we translate its error.
        const result = await client.query<UserRow>(
          `INSERT INTO users (email, password_hash, name)
           VALUES ($1, $2, $3)
           RETURNING id, email, name, role, email_verified_at`,
          [email, passwordHash, name],
        );
        inserted = result.rows[0];
      } catch (err) {
        if ((err as { code?: string }).code === PG_UNIQUE_VIOLATION) {
          throw AppError.conflict(ErrorCode.CONFLICT, 'An account with this email already exists');
        }
        throw err;
      }
      if (!inserted) {
        throw new Error('INSERT INTO users returned no row');
      }
      await sendVerificationEmail(client, inserted);
      return inserted;
    });

    res.status(201).json({ user: toUser(user), token: signToken(user) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/auth/login
// ---------------------------------------------------------------------------

const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1),
});

authRouter.post('/login', async (req, res, next) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequestFrom(parsed.error);
    }
    const { email, password } = parsed.data;

    const result = await pool.query<UserRow & { password_hash: string }>(
      `SELECT id, email, name, role, password_hash, email_verified_at
         FROM users
        WHERE lower(email) = $1`,
      [email],
    );
    const row = result.rows[0];

    // Same message and same bcrypt work for "no such email" and "wrong password", so
    // the login form cannot be used to find out who has an account.
    const passwordOk = await bcrypt.compare(password, row?.password_hash ?? DUMMY_HASH);
    if (!row || !passwordOk) {
      throw AppError.unauthorized('Email or password is incorrect');
    }

    res.json({ user: toUser(row), token: signToken(row) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/auth/me
// ---------------------------------------------------------------------------

authRouter.get('/me', requireAuth, async (req, res, next) => {
  try {
    // requireAuth guarantees req.user.
    const result = await pool.query<UserRow>(
      `SELECT id, email, name, role, email_verified_at FROM users WHERE id = $1`,
      [req.user!.id],
    );
    const user = result.rows[0];
    if (!user) {
      // Valid token for a user that has since been deleted.
      throw AppError.unauthorized();
    }

    res.json({ user: toUser(user) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/auth/verify-email
// ---------------------------------------------------------------------------

const verifyEmailSchema = z.object({ token: z.string().trim().min(1) });

authRouter.post('/verify-email', async (req, res, next) => {
  try {
    const parsed = verifyEmailSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequestFrom(parsed.error);
    }

    const userId = await consumeEmailToken(pool, parsed.data.token, 'verify_email');
    if (!userId) {
      throw new AppError(ErrorCode.INVALID_TOKEN, 'This link is invalid or has expired', 400);
    }

    const result = await pool.query<UserRow>(
      `UPDATE users
          SET email_verified_at = COALESCE(email_verified_at, now())
        WHERE id = $1
        RETURNING id, email, name, role, email_verified_at`,
      [userId],
    );
    const user = result.rows[0];
    if (!user) {
      throw AppError.unauthorized();
    }

    res.json({ user: toUser(user) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/auth/verify-email/resend
// ---------------------------------------------------------------------------

authRouter.post('/verify-email/resend', requireAuth, async (req, res, next) => {
  try {
    const result = await pool.query<UserRow>(
      `SELECT id, email, name, role, email_verified_at FROM users WHERE id = $1`,
      [req.user!.id],
    );
    const user = result.rows[0];
    if (!user) {
      throw AppError.unauthorized();
    }
    if (user.email_verified_at !== null) {
      throw AppError.conflict(ErrorCode.CONFLICT, 'Your email is already verified');
    }

    await withTransaction(async (client) => {
      await sendVerificationEmail(client, user);
    });
    res.json({ sent: true });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/auth/password-reset/request
// ---------------------------------------------------------------------------

const passwordResetRequestSchema = z.object({ email: emailSchema });

authRouter.post('/password-reset/request', async (req, res, next) => {
  try {
    const parsed = passwordResetRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequestFrom(parsed.error);
    }

    await withTransaction(async (client) => {
      const result = await client.query<UserRow>(
        `SELECT id, email, name, role, email_verified_at
           FROM users
          WHERE lower(email) = $1`,
        [parsed.data.email],
      );
      const user = result.rows[0];
      if (!user) {
        return;
      }

      const token = await createEmailToken(
        client,
        user.id,
        'reset_password',
        RESET_PASSWORD_TTL_MINUTES,
      );
      const link = `${webUrl()}/reset-password?token=${token}`;
      await sendEmail(client, {
        userId: user.id,
        to: user.email,
        kind: 'reset_password',
        subject: 'Reset your BiletFlow password',
        body: `Reset your BiletFlow password by opening this link:\n\n${link}\n\nThis link is valid for 1 hour. If you did not ask for this, ignore this email.`,
      });
    });

    res.json({ sent: true });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/auth/password-reset/confirm
// ---------------------------------------------------------------------------

const passwordResetConfirmSchema = z.object({
  token: z.string().trim().min(1),
  password: passwordSchema,
});

authRouter.post('/password-reset/confirm', async (req, res, next) => {
  try {
    const parsed = passwordResetConfirmSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequestFrom(parsed.error);
    }
    const { token, password } = parsed.data;

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const user = await withTransaction(async (client) => {
      const userId = await consumeEmailToken(client, token, 'reset_password');
      if (!userId) {
        throw new AppError(ErrorCode.INVALID_TOKEN, 'This link is invalid or has expired', 400);
      }

      const result = await client.query<UserRow>(
        `UPDATE users
            SET password_hash = $2,
                email_verified_at = COALESCE(email_verified_at, now())
          WHERE id = $1
          RETURNING id, email, name, role, email_verified_at`,
        [userId, passwordHash],
      );
      const updated = result.rows[0];
      if (!updated) {
        throw AppError.unauthorized();
      }

      await client.query(
        `UPDATE email_tokens
            SET used_at = now()
          WHERE user_id = $1
            AND purpose = 'reset_password'
            AND used_at IS NULL`,
        [userId],
      );
      return updated;
    });

    res.json({ user: toUser(user), token: signToken(user) });
  } catch (err) {
    next(err);
  }
});
