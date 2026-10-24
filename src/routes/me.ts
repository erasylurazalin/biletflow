/**
 * The logged-in user's own organizer profile. Same layering as routes/events.ts.
 *
 * Becoming an organizer is self-service: POST creates the profile and switches the
 * user's role to 'organizer' in the same statement, with no approval step. The token
 * carries the role (middleware/auth.ts), so POST answers with a fresh token; the old
 * one keeps saying the previous role until it expires.
 *
 * Payout details are demonstration data: payouts are simulated in the academic MVP.
 */
import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool';
import { withTransaction } from '../db/transaction';
import { recordAudit } from '../lib/audit';
import { AppError, ErrorCode } from '../lib/errors';
import { requireAuth, signToken, type AuthUser } from '../middleware/auth';

export const meRouter = Router();

// Postgres error codes: a unique constraint (one profile per user), and a foreign key
// (the user behind the token has been deleted).
const PG_UNIQUE_VIOLATION = '23505';
const PG_FOREIGN_KEY_VIOLATION = '23503';

const PROFILE_COLUMNS = `p.user_id, p.display_name, p.contact_email, p.contact_phone,
  p.payout_bank_name, p.payout_iban, p.payout_account_holder, p.identity_verified_at,
  p.created_at, p.updated_at`;

interface ProfileRow {
  user_id: string;
  display_name: string;
  contact_email: string | null;
  contact_phone: string | null;
  payout_bank_name: string | null;
  payout_iban: string | null;
  payout_account_holder: string | null;
  identity_verified_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  role: AuthUser['role'];
}

// docs/api.md "organizer_profile" object. The three payout columns are one nested
// object, or null when no payout account is set.
function toProfile(row: ProfileRow) {
  return {
    user_id: row.user_id,
    display_name: row.display_name,
    contact_email: row.contact_email,
    contact_phone: row.contact_phone,
    payout:
      row.payout_iban === null
        ? null
        : {
            bank_name: row.payout_bank_name,
            iban: row.payout_iban,
            account_holder: row.payout_account_holder,
          },
    identity_verified_at: row.identity_verified_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function badRequestFrom(error: z.ZodError): AppError {
  const first = error.issues[0];
  if (!first) {
    return AppError.badRequest('Invalid request body');
  }
  // Rules over the whole body (the contact rule, "send at least one field") have no
  // field to name.
  return AppError.badRequest(
    first.path.length > 0
      ? `Invalid field "${first.path.join('.')}": ${first.message}`
      : first.message,
  );
}

function notFound(): AppError {
  return AppError.notFound(
    ErrorCode.ORGANIZER_PROFILE_NOT_FOUND,
    'You do not have an organizer profile yet',
  );
}

const contactRequired = 'Give a contact_email or a contact_phone';

// Spaces, dashes and brackets are dropped, then it must be international format:
// "+7 (701) 123-45-67" is stored as "+77011234567".
const phoneSchema = z
  .string()
  .transform((s) => s.replace(/[\s()-]/g, ''))
  .pipe(z.string().regex(/^\+[1-9]\d{6,14}$/, 'Phone must be in international format, +7...'));

// Doc is silent on the IBAN check. Payouts are simulated, so this only checks the shape
// (country, check digits, account), not the checksum. Kazakh IBANs are 20 characters.
const ibanSchema = z
  .string()
  .transform((s) => s.replace(/\s/g, '').toUpperCase())
  .pipe(z.string().regex(/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/, 'Not an IBAN'));

const fields = {
  display_name: z.string().trim().min(1).max(100),
  contact_email: z.string().trim().toLowerCase().pipe(z.email()).nullable(),
  contact_phone: phoneSchema.nullable(),
  // All three or nothing (organizer_profiles_payout_complete). null removes it.
  payout: z
    .object({
      bank_name: z.string().trim().min(1).max(100),
      iban: ibanSchema,
      account_holder: z.string().trim().min(1).max(100),
    })
    .nullable(),
};

type ProfileInput = {
  [K in keyof typeof fields]: z.infer<(typeof fields)[K]>;
};

// The SQL parameters $2..$7 for a profile, in column order.
function profileParams(input: ProfileInput) {
  return [
    input.display_name,
    input.contact_email,
    input.contact_phone,
    input.payout?.bank_name ?? null,
    input.payout?.iban ?? null,
    input.payout?.account_holder ?? null,
  ];
}

// ---------------------------------------------------------------------------
// POST /api/me/organizer-profile  - become an organizer
// ---------------------------------------------------------------------------

const createSchema = z
  .object({
    display_name: fields.display_name,
    contact_email: fields.contact_email.default(null),
    contact_phone: fields.contact_phone.default(null),
    payout: fields.payout.default(null),
  })
  .refine((v) => v.contact_email !== null || v.contact_phone !== null, contactRequired);

meRouter.post('/organizer-profile', requireAuth, async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequestFrom(parsed.error);
    }

    const userResult = await pool.query<{ email_verified_at: Date | null }>(
      'SELECT email_verified_at FROM users WHERE id = $1',
      [req.user!.id],
    );
    const account = userResult.rows[0];
    if (!account) {
      throw AppError.unauthorized();
    }
    if (account.email_verified_at === null) {
      throw new AppError(
        ErrorCode.EMAIL_NOT_VERIFIED,
        'Verify your email before creating an organizer profile',
        403,
      );
    }

    // One statement, so the profile and the role change happen together or not at
    // all. A platform_admin keeps their role: organizing must not demote them.
    let row: (ProfileRow & UserRow) | undefined;
    try {
      // requireAuth guarantees req.user.
      const result = await pool.query<ProfileRow & UserRow>(
        `WITH p AS (
           INSERT INTO organizer_profiles
                  (user_id, display_name, contact_email, contact_phone,
                   payout_bank_name, payout_iban, payout_account_holder)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING *
         ), u AS (
           UPDATE users
              SET role = 'organizer'
            WHERE id = $1
              AND role <> 'platform_admin'
              AND role <> 'organizer'
           RETURNING id, email, name, role
         )
         SELECT ${PROFILE_COLUMNS},
                users.id, users.email, users.name,
                COALESCE(u.role, users.role) AS role
           FROM p
           JOIN users ON users.id = p.user_id
           LEFT JOIN u ON u.id = p.user_id`,
        [req.user!.id, ...profileParams(parsed.data)],
      );
      row = result.rows[0];
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === PG_UNIQUE_VIOLATION) {
        throw AppError.conflict(
          ErrorCode.CONFLICT,
          'You already have an organizer profile. Edit it with PATCH instead.',
        );
      }
      if (code === PG_FOREIGN_KEY_VIOLATION) {
        // Valid token for a user that has since been deleted.
        throw AppError.unauthorized();
      }
      throw err;
    }
    if (!row) {
      throw new Error('INSERT INTO organizer_profiles returned no row');
    }

    const user = { id: row.id, email: row.email, name: row.name, role: row.role };
    res.status(201).json({ organizer_profile: toProfile(row), user, token: signToken(user) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/me/organizer-profile  - read my profile
// ---------------------------------------------------------------------------

async function loadProfile(userId: string): Promise<ProfileRow> {
  const result = await pool.query<ProfileRow>(
    `SELECT ${PROFILE_COLUMNS} FROM organizer_profiles p WHERE p.user_id = $1`,
    [userId],
  );
  const row = result.rows[0];
  if (!row) {
    throw notFound();
  }
  return row;
}

meRouter.get('/organizer-profile', requireAuth, async (req, res, next) => {
  try {
    const row = await loadProfile(req.user!.id);
    res.json({ organizer_profile: toProfile(row) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/me/organizer-profile  - edit some fields of my profile
// ---------------------------------------------------------------------------

const updateSchema = z
  .object(fields)
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Send at least one field to change');

meRouter.patch('/organizer-profile', requireAuth, async (req, res, next) => {
  try {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequestFrom(parsed.error);
    }

    const existing = await loadProfile(req.user!.id);
    // Fields left out of the body keep their current value.
    const merged: ProfileInput = {
      display_name: existing.display_name,
      contact_email: existing.contact_email,
      contact_phone: existing.contact_phone,
      payout:
        existing.payout_iban === null
          ? null
          : {
              bank_name: existing.payout_bank_name!,
              iban: existing.payout_iban,
              account_holder: existing.payout_account_holder!,
            },
      ...parsed.data,
    };
    if (merged.contact_email === null && merged.contact_phone === null) {
      throw AppError.badRequest(contactRequired);
    }

    const result = await pool.query<ProfileRow>(
      `UPDATE organizer_profiles p
          SET display_name = $2,
              contact_email = $3,
              contact_phone = $4,
              payout_bank_name = $5,
              payout_iban = $6,
              payout_account_holder = $7
        WHERE p.user_id = $1
       RETURNING ${PROFILE_COLUMNS}`,
      [req.user!.id, ...profileParams(merged)],
    );
    const row = result.rows[0];
    if (!row) {
      // Deleted between the read and the update.
      throw notFound();
    }

    res.json({ organizer_profile: toProfile(row) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/me/organizer-profile/verify-identity  - simulated identity check
// ---------------------------------------------------------------------------

// SRS 3.2 step 2 for paid sales. The academic MVP simulates it (SRS 3.2 allows that), so
// it takes nothing, stores no document numbers and always succeeds. Only the first call
// changes the profile and writes an audit entry; a repeat returns the same profile.
meRouter.post('/organizer-profile/verify-identity', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const row = await withTransaction(async (client) => {
      const result = await client.query<ProfileRow & { organizer_profile_id: string }>(
        `UPDATE organizer_profiles p
            SET identity_verified_at = now()
          WHERE p.user_id = $1
            AND p.identity_verified_at IS NULL
         RETURNING ${PROFILE_COLUMNS}, p.id AS organizer_profile_id`,
        [userId],
      );
      const verified = result.rows[0];
      if (verified) {
        await recordAudit(client, {
          actorId: userId,
          action: 'organizer_profile.identity_verified',
          entityType: 'organizer_profile',
          entityId: verified.organizer_profile_id,
          description: 'Completed the simulated organizer identity check',
        });
        return verified;
      }

      const existing = await client.query<ProfileRow>(
        `SELECT ${PROFILE_COLUMNS} FROM organizer_profiles p WHERE p.user_id = $1`,
        [userId],
      );
      const profile = existing.rows[0];
      if (!profile) {
        throw notFound();
      }
      return profile;
    });

    res.json({ organizer_profile: toProfile(row) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/me/emails  - simulated inbox
// ---------------------------------------------------------------------------

meRouter.get('/emails', requireAuth, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT e.id, e.kind, e.subject, e.body, e.created_at
         FROM email_outbox e
         JOIN users u ON lower(u.email) = lower(e.to_email)
        WHERE u.id = $1
        ORDER BY e.created_at DESC
        LIMIT 50`,
      [req.user!.id],
    );
    res.json({ emails: result.rows });
  } catch (err) {
    next(err);
  }
});
