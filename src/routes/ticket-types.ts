/**
 * Organizer endpoints for ticket types: create, edit, delete. Same layering as
 * routes/events.ts.
 *
 * Every endpoint here needs a logged-in user who owns the event. A missing event or
 * ticket type is 404; one that belongs to somebody else's event is 403.
 *
 * quantity_available is never stored (see 001_init.sql), so keeping it correct means two
 * rules: quantity_total cannot drop below what orders already hold, and a ticket type
 * that appears in any order cannot be deleted, only hidden.
 */
import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool';
import { AppError, ErrorCode } from '../lib/errors';
import { requireAuth } from '../middleware/auth';

// Mounted at /api, because the paths start in two places (/events/:id/ticket-types and
// /ticket-types/:id). requireAuth goes on each route, never on router.use(): this router
// sees every /api request, and the public ones must not demand a token.
export const ticketTypesRouter = Router();

// Postgres error code for a foreign key violation: order_items still points at the row.
const PG_FOREIGN_KEY_VIOLATION = '23503';

// price and quantity_total are INTEGER columns.
const PG_INT_MAX = 2_147_483_647;

// Seats held by orders for the ticket type aliased `tt`: paid ones for good, pending ones
// until they expire. Same rule as the availability query in routes/events.ts. This is a
// constant, never user input, so putting it into the SQL with ${} is safe.
const HELD_SQL = `COALESCE((
    SELECT SUM(oi.quantity)
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
     WHERE oi.ticket_type_id = tt.id
       AND (o.status = 'paid'
            OR (o.status = 'pending' AND (o.expires_at IS NULL OR o.expires_at > now())))
  ), 0)::int`;

const TICKET_TYPE_COLUMNS = `tt.id, tt.name, tt.price, tt.currency, tt.quantity_total,
  tt.sales_start_at, tt.sales_end_at, tt.is_hidden`;

interface TicketTypeRow {
  id: string;
  name: string;
  price: number;
  currency: string;
  quantity_total: number;
  quantity_available: number;
  sales_start_at: Date | null;
  sales_end_at: Date | null;
  is_hidden: boolean;
}

// docs/api.md "ticket_type" object.
function toTicketType(row: TicketTypeRow) {
  return {
    id: row.id,
    name: row.name,
    price: row.price,
    currency: row.currency,
    quantity_total: row.quantity_total,
    quantity_available: row.quantity_available,
    sales_start_at: row.sales_start_at,
    sales_end_at: row.sales_end_at,
    is_hidden: row.is_hidden,
  };
}

function badRequestFrom(error: z.ZodError): AppError {
  const first = error.issues[0];
  return AppError.badRequest(
    first ? `Invalid field "${first.path.join('.')}": ${first.message}` : 'Invalid request body',
  );
}

function forbidden(): AppError {
  return AppError.forbidden("Only the event's organizer can change its ticket types");
}

// Doc is silent: the sales window, when both ends are set, must not end before it starts.
function checkSalesWindow(start: Date | null, end: Date | null): void {
  if (start && end && end <= start) {
    throw AppError.badRequest('sales_end_at must be after sales_start_at');
  }
}

const idParamSchema = z.object({ id: z.uuid() });

// Timestamps arrive as ISO 8601 strings ("2026-11-14T18:00:00Z"). null clears one.
const timestampSchema = z.iso
  .datetime({ offset: true })
  .transform((s) => new Date(s))
  .nullable();

const fields = {
  name: z.string().trim().min(1).max(100),
  price: z.number().int().min(0).max(PG_INT_MAX),
  // Everything is KZT for now (001_init.sql). Accepting the field but refusing anything
  // else means a client sending "USD" hears about it instead of being silently ignored.
  currency: z.literal('KZT'),
  quantity_total: z.number().int().min(0).max(PG_INT_MAX),
  sales_start_at: timestampSchema,
  sales_end_at: timestampSchema,
  is_hidden: z.boolean(),
};

// ---------------------------------------------------------------------------
// POST /api/events/:id/ticket-types  - add a ticket type to my event
// ---------------------------------------------------------------------------

const createSchema = z.object({
  name: fields.name,
  price: fields.price,
  currency: fields.currency.default('KZT'),
  quantity_total: fields.quantity_total,
  sales_start_at: fields.sales_start_at.default(null),
  sales_end_at: fields.sales_end_at.default(null),
  is_hidden: fields.is_hidden.default(false),
});

ticketTypesRouter.post('/events/:id/ticket-types', requireAuth, async (req, res, next) => {
  try {
    const params = idParamSchema.safeParse(req.params);
    if (!params.success) {
      throw AppError.badRequest('Event id must be a UUID');
    }
    const body = createSchema.safeParse(req.body);
    if (!body.success) {
      throw badRequestFrom(body.error);
    }
    const input = body.data;
    checkSalesWindow(input.sales_start_at, input.sales_end_at);

    const eventResult = await pool.query<{ organizer_id: string }>(
      `SELECT organizer_id FROM events WHERE id = $1`,
      [params.data.id],
    );
    const event = eventResult.rows[0];
    if (!event) {
      throw AppError.notFound(ErrorCode.EVENT_NOT_FOUND, 'Event not found');
    }
    // requireAuth guarantees req.user.
    if (event.organizer_id !== req.user!.id) {
      throw forbidden();
    }

    // A new ticket type has no orders yet, so everything is available.
    const result = await pool.query<TicketTypeRow>(
      `INSERT INTO ticket_types AS tt
              (event_id, name, price, currency, quantity_total,
               sales_start_at, sales_end_at, is_hidden)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${TICKET_TYPE_COLUMNS}, tt.quantity_total AS quantity_available`,
      [
        params.data.id,
        input.name,
        input.price,
        input.currency,
        input.quantity_total,
        input.sales_start_at,
        input.sales_end_at,
        input.is_hidden,
      ],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error('INSERT INTO ticket_types returned no row');
    }

    res.status(201).json({ ticket_type: toTicketType(row) });
  } catch (err) {
    next(err);
  }
});

// The ticket type together with what the owner check and the quantity rule need.
interface ExistingRow extends TicketTypeRow {
  organizer_id: string;
  held: number;
}

// 404 if the ticket type does not exist, 403 if it is not on one of my events.
async function loadOwnedTicketType(id: string, userId: string): Promise<ExistingRow> {
  const result = await pool.query<ExistingRow>(
    `SELECT ${TICKET_TYPE_COLUMNS},
            ${HELD_SQL} AS held,
            tt.quantity_total - ${HELD_SQL} AS quantity_available,
            e.organizer_id
       FROM ticket_types tt
       JOIN events e ON e.id = tt.event_id
      WHERE tt.id = $1`,
    [id],
  );
  const row = result.rows[0];
  if (!row) {
    throw AppError.notFound(ErrorCode.NOT_FOUND, 'Ticket type not found');
  }
  if (row.organizer_id !== userId) {
    throw forbidden();
  }
  return row;
}

// ---------------------------------------------------------------------------
// PATCH /api/ticket-types/:id  - edit some fields of a ticket type on my event
// ---------------------------------------------------------------------------

const updateSchema = z
  .object({
    name: fields.name,
    price: fields.price,
    currency: fields.currency,
    quantity_total: fields.quantity_total,
    sales_start_at: fields.sales_start_at,
    sales_end_at: fields.sales_end_at,
    is_hidden: fields.is_hidden,
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Send at least one field to change');

ticketTypesRouter.patch('/ticket-types/:id', requireAuth, async (req, res, next) => {
  try {
    const params = idParamSchema.safeParse(req.params);
    if (!params.success) {
      throw AppError.badRequest('Ticket type id must be a UUID');
    }
    const body = updateSchema.safeParse(req.body);
    if (!body.success) {
      throw badRequestFrom(body.error);
    }

    const existing = await loadOwnedTicketType(params.data.id, req.user!.id);
    // Fields left out of the body keep their current value.
    const merged = { ...existing, ...body.data };
    checkSalesWindow(merged.sales_start_at, merged.sales_end_at);

    const tooFew = () =>
      AppError.conflict(
        ErrorCode.CONFLICT,
        `Orders already hold ${existing.held} of these tickets, so quantity_total cannot go below that`,
      );
    if (merged.quantity_total < existing.held) {
      throw tooFew();
    }

    // The quantity rule is checked again inside the UPDATE, because an order may have
    // come in since the SELECT above. No row back means it did.
    const result = await pool.query<TicketTypeRow>(
      `UPDATE ticket_types tt
          SET name = $2,
              price = $3,
              currency = $4,
              quantity_total = $5,
              sales_start_at = $6,
              sales_end_at = $7,
              is_hidden = $8
        WHERE tt.id = $1
          AND $5 >= ${HELD_SQL}
       RETURNING ${TICKET_TYPE_COLUMNS}, tt.quantity_total - ${HELD_SQL} AS quantity_available`,
      [
        existing.id,
        merged.name,
        merged.price,
        merged.currency,
        merged.quantity_total,
        merged.sales_start_at,
        merged.sales_end_at,
        merged.is_hidden,
      ],
    );
    const row = result.rows[0];
    if (!row) {
      throw tooFew();
    }

    res.json({ ticket_type: toTicketType(row) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/ticket-types/:id  - remove a ticket type nobody has ordered
// ---------------------------------------------------------------------------

ticketTypesRouter.delete('/ticket-types/:id', requireAuth, async (req, res, next) => {
  try {
    const params = idParamSchema.safeParse(req.params);
    if (!params.success) {
      throw AppError.badRequest('Ticket type id must be a UUID');
    }

    await loadOwnedTicketType(params.data.id, req.user!.id);

    try {
      // No "count the orders first": the foreign key from order_items decides, including
      // for cancelled orders, which are still financial records.
      await pool.query(`DELETE FROM ticket_types WHERE id = $1`, [params.data.id]);
    } catch (err) {
      if ((err as { code?: string }).code === PG_FOREIGN_KEY_VIOLATION) {
        throw AppError.conflict(
          ErrorCode.CONFLICT,
          'This ticket type has orders, so it cannot be deleted. Set is_hidden instead.',
        );
      }
      throw err;
    }

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
