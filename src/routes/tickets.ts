/**
 * The logged-in user's tickets. Same layering as routes/events.ts.
 *
 * A ticket belongs to whoever placed the order it came from. Anybody else's ticket is
 * 404 TICKET_NOT_FOUND, never 403, so ticket ids cannot be probed.
 *
 * qr_payload is not a column (migration 001): it is signed here, every time a ticket is
 * returned, by src/lib/qr.ts. routes/orders.ts returns tickets in the same shape through
 * TICKET_SELECT and toTicket() below.
 */
import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool';
import { AppError, ErrorCode } from '../lib/errors';
import { signTicketPayload } from '../lib/qr';
import { renderTicketPdf } from '../lib/ticket-pdf';
import { requireAuth } from '../middleware/auth';

export const ticketsRouter = Router();

// Every ticket query starts here and adds its own WHERE. ticket_type_name comes from the
// order item, the name the buyer saw, so renaming the tier later does not change it.
// venue_address is read for the printable PDF only: it stays out of the API's ticket
// object (docs/api.md).
export const TICKET_SELECT = `SELECT t.id,
         t.code,
         t.status,
         t.attendee_name,
         oi.name      AS ticket_type_name,
         e.id         AS event_id,
         e.title      AS event_title,
         e.starts_at  AS event_starts_at,
         e.venue_name AS event_venue_name,
         e.venue_address AS event_venue_address
    FROM tickets t
    JOIN order_items oi ON oi.id = t.order_item_id
    JOIN orders o ON o.id = oi.order_id
    JOIN events e ON e.id = t.event_id`;

export interface TicketRow {
  id: string;
  code: string;
  status: string;
  attendee_name: string;
  ticket_type_name: string;
  event_id: string;
  event_title: string;
  event_starts_at: Date;
  event_venue_name: string;
  event_venue_address: string;
}

// docs/api.md "ticket" object.
export function toTicket(row: TicketRow) {
  return {
    id: row.id,
    code: row.code,
    status: row.status,
    attendee_name: row.attendee_name,
    ticket_type_name: row.ticket_type_name,
    event: {
      id: row.event_id,
      title: row.event_title,
      starts_at: row.event_starts_at,
      venue_name: row.event_venue_name,
    },
    qr_payload: signTicketPayload(row.id),
  };
}

// Same paging as GET /api/events (docs/api.md "List responses").
const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

const idParamSchema = z.object({ id: z.uuid() });

// ---------------------------------------------------------------------------
// GET /api/tickets  - my tickets, soonest event first
// ---------------------------------------------------------------------------

ticketsRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw AppError.badRequest(
        first
          ? `Invalid query parameter "${first.path.join('.')}": ${first.message}`
          : 'Invalid query',
      );
    }
    const { limit, offset } = parsed.data;

    // Every status, so a checked-in or cancelled ticket stays visible to its owner.
    // requireAuth guarantees req.user.
    const result = await pool.query<TicketRow>(
      `${TICKET_SELECT}
        WHERE o.user_id = $1
        ORDER BY e.starts_at ASC, t.code ASC
        LIMIT $2 OFFSET $3`,
      [req.user!.id, limit, offset],
    );

    res.json({ tickets: result.rows.map(toTicket), limit, offset });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/tickets/:id  - one of my tickets
// ---------------------------------------------------------------------------

ticketsRouter.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const parsed = idParamSchema.safeParse(req.params);
    if (!parsed.success) {
      throw AppError.badRequest('Ticket id must be a UUID');
    }

    const result = await pool.query<TicketRow>(
      `${TICKET_SELECT}
        WHERE t.id = $1
          AND o.user_id = $2`,
      [parsed.data.id, req.user!.id],
    );
    const row = result.rows[0];
    if (!row) {
      throw AppError.notFound(ErrorCode.TICKET_NOT_FOUND, 'Ticket not found');
    }

    res.json({ ticket: toTicket(row) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/tickets/:id/pdf  - the printable ticket, rendered on every request
// ---------------------------------------------------------------------------

ticketsRouter.get('/:id/pdf', requireAuth, async (req, res, next) => {
  try {
    const parsed = idParamSchema.safeParse(req.params);
    if (!parsed.success) {
      throw AppError.badRequest('Ticket id must be a UUID');
    }

    // Same ownership clause as GET /:id, so a stranger's ticket is a 404 here too.
    const result = await pool.query<TicketRow>(
      `${TICKET_SELECT}
        WHERE t.id = $1
          AND o.user_id = $2`,
      [parsed.data.id, req.user!.id],
    );
    const row = result.rows[0];
    if (!row) {
      throw AppError.notFound(ErrorCode.TICKET_NOT_FOUND, 'Ticket not found');
    }

    // Every status prints: the page carries the status and the ticket's own qr_payload,
    // so printed paper and the phone are one admission and the scanner decides what is
    // valid (docs/decisions.md, decision 13).
    const ticket = toTicket(row);
    const pdf = await renderTicketPdf({
      ...ticket,
      event: { ...ticket.event, venue_address: row.event_venue_address },
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="biletflow-${ticket.code}.pdf"`);
    res.send(pdf);
  } catch (err) {
    next(err);
  }
});
