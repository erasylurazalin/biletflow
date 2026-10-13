/**
 * Paid sales activation (SRS 3.2, 4.5, UC2): the checklist an organizer works through
 * before paid ticket types on their event can be bought. Same layering as
 * routes/events.ts.
 *
 * The checklist has five items, read from three places (migration 004):
 *   paid_ticket_type     the event has a ticket type with a price above 0
 *   identity_verified    organizer_profiles.identity_verified_at, set by the simulated
 *                        check in routes/me.ts
 *   payout_account       the payout account on the organizer profile
 *   activation_fee_paid  a simulated 'activation_fee' payment for this event
 *   terms_accepted       paid_sales_activations.terms_accepted_at
 *
 * Identity and payout belong to the organizer and count for every event. The fee and
 * the terms are per event, and so is activation: it applies only to the selected event.
 *
 * Every endpoint here is for the event's organizer: a missing event is 404, somebody
 * else's event is 403.
 */
import { Router } from 'express';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { pool } from '../db/pool';
import { AppError, ErrorCode } from '../lib/errors';
import { PAYMENT_COLUMNS, toPayment, type PaymentColumns } from '../lib/payments';
import { requireAuth } from '../middleware/auth';

// Mounted at /api, because the paths start with /events/:id. requireAuth goes on each
// route, never on router.use(): this router sees every /api request, and the public ones
// must not demand a token.
export const paidSalesRouter = Router();

// The Paid Sales Activation Fee in tiyn: 5,000 KZT. SRS 3.3 leaves the amount open, so
// this is our pick (docs/decisions.md). Platform admins configuring it comes later.
export const ACTIVATION_FEE = 500000;

// Postgres error code for a unique violation: the fee for this event is already paid.
const PG_UNIQUE_VIOLATION = '23505';

const idParamSchema = z.object({ id: z.uuid() });

interface PaidSalesRow extends PaymentColumns {
  event_id: string;
  organizer_id: string;
  event_status: string;
  paid_ticket_type: boolean;
  identity_verified: boolean;
  payout_account: boolean;
  terms_accepted_at: Date | null;
  activated_at: Date | null;
}

// Missing organizer profile or activation row reads as "not done": a NULL from a LEFT
// JOIN makes `IS NOT NULL` false.
const PAID_SALES_SELECT = `SELECT e.id AS event_id,
         e.organizer_id,
         e.status AS event_status,
         EXISTS (SELECT 1 FROM ticket_types tt WHERE tt.event_id = e.id AND tt.price > 0)
           AS paid_ticket_type,
         op.identity_verified_at IS NOT NULL AS identity_verified,
         op.payout_iban IS NOT NULL AS payout_account,
         psa.terms_accepted_at,
         psa.activated_at,
         ${PAYMENT_COLUMNS}
    FROM events e
    LEFT JOIN organizer_profiles op ON op.user_id = e.organizer_id
    LEFT JOIN paid_sales_activations psa ON psa.event_id = e.id
    LEFT JOIN payments pay ON pay.event_id = e.id AND pay.purpose = 'activation_fee'
   WHERE e.id = $1`;

function checklistOf(row: PaidSalesRow) {
  return {
    paid_ticket_type: row.paid_ticket_type,
    identity_verified: row.identity_verified,
    payout_account: row.payout_account,
    activation_fee_paid: row.payment_paid_at !== null,
    terms_accepted: row.terms_accepted_at !== null,
  };
}

// What each unfinished item is called in the 409 message.
const MISSING_LABELS: Record<keyof ReturnType<typeof checklistOf>, string> = {
  paid_ticket_type: 'a ticket type with a price',
  identity_verified: 'identity verification',
  payout_account: 'a payout account on your organizer profile',
  activation_fee_paid: 'the activation fee',
  terms_accepted: 'accepting the paid-event terms',
};

// docs/api.md "paid_sales" object.
function toPaidSales(row: PaidSalesRow) {
  return {
    event_id: row.event_id,
    status: row.activated_at === null ? 'inactive' : 'active',
    checklist: checklistOf(row),
    activation_fee: {
      amount: ACTIVATION_FEE,
      currency: 'KZT',
      payment: toPayment(row),
    },
    terms_accepted_at: row.terms_accepted_at,
    activated_at: row.activated_at,
  };
}

// 404 if the event does not exist, 403 if it is not mine. Returns the checklist as it is.
async function loadOwnPaidSales(
  db: Pool | PoolClient,
  eventId: string,
  userId: string,
): Promise<PaidSalesRow> {
  const result = await db.query<PaidSalesRow>(PAID_SALES_SELECT, [eventId]);
  const row = result.rows[0];
  if (!row) {
    throw AppError.notFound(ErrorCode.EVENT_NOT_FOUND, 'Event not found');
  }
  if (row.organizer_id !== userId) {
    throw AppError.forbidden("Only the event's organizer can manage its paid sales");
  }
  return row;
}

// The three POSTs change the event, which makes no sense once it is cancelled.
function assertNotCancelled(row: PaidSalesRow): void {
  if (row.event_status === 'cancelled') {
    throw AppError.conflict(ErrorCode.CONFLICT, 'This event has been cancelled');
  }
}

function parseEventId(params: unknown): string {
  const parsed = idParamSchema.safeParse(params);
  if (!parsed.success) {
    throw AppError.badRequest('Event id must be a UUID');
  }
  return parsed.data.id;
}

// ---------------------------------------------------------------------------
// GET /api/events/:id/paid-sales  - the activation checklist
// ---------------------------------------------------------------------------

paidSalesRouter.get('/events/:id/paid-sales', requireAuth, async (req, res, next) => {
  try {
    const eventId = parseEventId(req.params);
    // requireAuth guarantees req.user.
    const row = await loadOwnPaidSales(pool, eventId, req.user!.id);

    res.json({ paid_sales: toPaidSales(row) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/events/:id/paid-sales/activation-fee  - simulated payment of the fee
// ---------------------------------------------------------------------------

paidSalesRouter.post(
  '/events/:id/paid-sales/activation-fee',
  requireAuth,
  async (req, res, next) => {
    try {
      const eventId = parseEventId(req.params);
      const userId = req.user!.id;
      const before = await loadOwnPaidSales(pool, eventId, userId);
      assertNotCancelled(before);

      // SRS 4.5: the system records payment of the activation fee. Simulated, so it
      // always succeeds. Paying twice is refused by the unique index, which also covers
      // two clicks racing each other.
      try {
        await pool.query(
          `INSERT INTO payments (purpose, event_id, paid_by, amount, method)
           VALUES ('activation_fee', $1, $2, $3, 'simulated')`,
          [eventId, userId, ACTIVATION_FEE],
        );
      } catch (err) {
        if ((err as { code?: string }).code === PG_UNIQUE_VIOLATION) {
          throw AppError.conflict(
            ErrorCode.CONFLICT,
            'The activation fee for this event is already paid',
          );
        }
        throw err;
      }

      res.json({ paid_sales: toPaidSales(await loadOwnPaidSales(pool, eventId, userId)) });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/events/:id/paid-sales/terms  - accept the paid-event terms
// ---------------------------------------------------------------------------

// Only an explicit true counts as accepting. A missing body is not consent.
const termsSchema = z.object({ accepted: z.literal(true) });

paidSalesRouter.post('/events/:id/paid-sales/terms', requireAuth, async (req, res, next) => {
  try {
    const eventId = parseEventId(req.params);
    const body = termsSchema.safeParse(req.body);
    if (!body.success) {
      throw AppError.badRequest('Send { "accepted": true } to accept the paid-event terms');
    }
    const userId = req.user!.id;
    const before = await loadOwnPaidSales(pool, eventId, userId);
    assertNotCancelled(before);

    // The first acceptance is the one that counts: accepting again changes nothing.
    await pool.query(
      `INSERT INTO paid_sales_activations AS psa (event_id, terms_accepted_at, terms_accepted_by)
       VALUES ($1, now(), $2)
       ON CONFLICT (event_id) DO UPDATE
         SET terms_accepted_at = COALESCE(psa.terms_accepted_at, EXCLUDED.terms_accepted_at),
             terms_accepted_by = COALESCE(psa.terms_accepted_by, EXCLUDED.terms_accepted_by)`,
      [eventId, userId],
    );

    res.json({ paid_sales: toPaidSales(await loadOwnPaidSales(pool, eventId, userId)) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/events/:id/paid-sales/activate  - turn on paid sales for this event
// ---------------------------------------------------------------------------

paidSalesRouter.post('/events/:id/paid-sales/activate', requireAuth, async (req, res, next) => {
  try {
    const eventId = parseEventId(req.params);
    const userId = req.user!.id;
    const before = await loadOwnPaidSales(pool, eventId, userId);
    assertNotCancelled(before);

    // Already active: nothing to do, and not an error.
    if (before.activated_at === null) {
      // SRS 4.5: the system verifies the requirements are complete, at this moment.
      const checklist = checklistOf(before);
      const missing = (Object.keys(checklist) as (keyof typeof checklist)[])
        .filter((key) => !checklist[key])
        .map((key) => MISSING_LABELS[key]);
      if (missing.length > 0) {
        throw AppError.conflict(
          ErrorCode.PAID_SALES_INCOMPLETE,
          `Paid sales cannot be activated yet. Still missing: ${missing.join(', ')}.`,
        );
      }

      // terms_accepted is on the checklist, so the row exists by now.
      await pool.query(
        `UPDATE paid_sales_activations
            SET activated_at = COALESCE(activated_at, now()),
                activated_by = COALESCE(activated_by, $2)
          WHERE event_id = $1`,
        [eventId, userId],
      );
    }

    res.json({ paid_sales: toPaidSales(await loadOwnPaidSales(pool, eventId, userId)) });
  } catch (err) {
    next(err);
  }
});
