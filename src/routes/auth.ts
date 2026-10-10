/**
 * Auth endpoints: register, login, me. Same layering as routes/events.ts.
 *
 * Passwords are hashed with bcrypt (bcryptjs: same algorithm, no native build step on
 * Windows). The token is a JWT carrying { id, role }, signed and verified in
 * middleware/auth.ts.
 */
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { pool } from '../db/pool';
import { AppError, ErrorCode } from '../lib/errors';
import { requireAuth, signToken, type AuthUser } from '../middleware/auth';

export const authRouter = Router();

// 10 rounds is ~50-100ms per hash: slow for an attacker, unnoticeable for a person.
const BCRYPT_ROUNDS = 10;

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
}

// docs/api.md "user" object. password_hash must never leave this file.
function toUser(row: UserRow) {
  return { id: row.id, email: row.email, name: row.name, role: row.role };
}

function badRequestFrom(error: z.ZodError): AppError {
  const first = error.issues[0];
  return AppError.badRequest(
    first ? `Invalid field "${first.path.join('.')}": ${first.message}` : 'Invalid request body',
  );
}

// Emails are stored and compared lower-cased (see users_email_lower_idx).
const emailSchema = z.string().trim().toLowerCase().pipe(z.email());

// ---------------------------------------------------------------------------
// POST /api/auth/register
// ---------------------------------------------------------------------------

const registerSchema = z.object({
  email: emailSchema,
  // bcrypt ignores everything after 72 bytes, so refuse longer passwords rather than
  // silently accepting a password that only partly counts.
  password: z
    .string()
    .min(8)
    .refine((p) => Buffer.byteLength(p) <= 72, 'Password must be at most 72 bytes'),
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

    let user: UserRow | undefined;
    try {
      // No "SELECT first, then INSERT": two requests could both pass the check. The
      // unique index decides, and we translate its error.
      const result = await pool.query<UserRow>(
        `INSERT INTO users (email, password_hash, name)
         VALUES ($1, $2, $3)
         RETURNING id, email, name, role`,
        [email, passwordHash, name],
      );
      user = result.rows[0];
    } catch (err) {
      if ((err as { code?: string }).code === PG_UNIQUE_VIOLATION) {
        throw AppError.conflict(ErrorCode.CONFLICT, 'An account with this email already exists');
      }
      throw err;
    }
    if (!user) {
      throw new Error('INSERT INTO users returned no row');
    }

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
      `SELECT id, email, name, role, password_hash
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
      `SELECT id, email, name, role FROM users WHERE id = $1`,
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
