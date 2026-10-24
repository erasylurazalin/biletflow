/**
 * Door check-in for event staff (SRS 4.8, UC4): scan a ticket, undo a scan, and search
 * the attendee list. Only people with a row in event_staff for the event get in; the
 * role and being the organizer do not count (docs/decisions.md, decision 2).
 *
 * A scan is a conditional UPDATE ... WHERE status = 'valid', so two phones scanning the
 * same ticket at the same moment cannot both admit it: the second waits for the row
 * lock, sees checked_in and answers already_used.
 */
import { Router } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { pool } from '../db/pool';
import { withTransaction } from '../db/transaction';
import { recordAudit } from '../lib/audit';
import { AppError, ErrorCode } from '../lib/errors';
import { verifyTicketPayload } from '../lib/qr';
import { requireAuth } from '../middleware/auth';

export const checkInRouter = Router();

type TicketStatus = 'valid' | 'checked_in' | 'cancelled' | 'refunded';

interface TicketRow {
  id: string;
  code: string;
  status: TicketStatus;
  attendee_name: string;
  ticket_type_name: string;
  checked_in_at: Date | null;
  event_id: string;
}

function toTicket(row: TicketRow) {
  return {
    id: row.id,
    code: row.code,
    status: row.status,
    attendee_name: row.attendee_name,
    ticket_type_name: row.ticket_type_name,
    checked_in_at: row.checked_in_at,
  };
}

const TICKET_SELECT = `SELECT t.id,
         t.code,
         t.status,
         t.attendee_name,
         tt.name AS ticket_type_name,
         t.checked_in_at,
         t.event_id
    FROM tickets t
    JOIN ticket_types tt ON tt.id = t.ticket_type_id`;

async function assertAssigned(eventId: string, userId: string, client?: PoolClient): Promise<void> {
  const result = client
    ? await client.query(`SELECT 1 FROM event_staff WHERE event_id = $1 AND user_id = $2`, [
        eventId,
        userId,
      ])
    : await pool.query(`SELECT 1 FROM event_staff WHERE event_id = $1 AND user_id = $2`, [
        eventId,
        userId,
      ]);
  if (result.rowCount === 0) {
    throw AppError.forbidden('You are not assigned to this event');
  }
}

function badRequestFrom(error: z.ZodError, what: string): AppError {
  const first = error.issues[0];
  return AppError.badRequest(
    first ? `Invalid ${what} "${first.path.join('.')}": ${first.message}` : `Invalid ${what}`,
  );
}

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  q: z.string().trim().max(100).optional(),
});

function parseListQuery(query: unknown) {
  const parsed = listQuerySchema.safeParse(query);
  if (!parsed.success) {
    throw badRequestFrom(parsed.error, 'query parameter');
  }
  return parsed.data;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

const checkInBodySchema = z.object({
  event_id: z.uuid(),
  qr_payload: z.string().trim().min(1),
});

checkInRouter.post('/staff/check-in', requireAuth, async (req, res, next) => {
  try {
    const body = checkInBodySchema.safeParse(req.body);
    if (!body.success) {
      throw badRequestFrom(body.error, 'field');
    }
    const { event_id: eventId, qr_payload: qrPayload } = body.data;
    const userId = req.user!.id;

    await assertAssigned(eventId, userId);

    const verification = verifyTicketPayload(qrPayload);
    if (!verification.ok) {
      res.json({ result: 'invalid', ticket: null });
      return;
    }

    const outcome = await withTransaction(async (client) => {
      const updatedResult = await client.query<TicketRow>(
        `WITH updated AS (
           UPDATE tickets
              SET status = 'checked_in', checked_in_at = now(), checked_in_by = $1
            WHERE id = $2 AND event_id = $3 AND status = 'valid'
            RETURNING id, code, status, attendee_name, ticket_type_id, checked_in_at, event_id
         )
         SELECT u.id,
                u.code,
                u.status,
                u.attendee_name,
                tt.name AS ticket_type_name,
                u.checked_in_at,
                u.event_id
           FROM updated u
           JOIN ticket_types tt ON tt.id = u.ticket_type_id`,
        [userId, verification.ticketId, eventId],
      );
      const updated = updatedResult.rows[0];
      if (updated) {
        await recordAudit(client, {
          actorId: userId,
          action: 'ticket.checked_in',
          entityType: 'ticket',
          entityId: updated.id,
          eventId,
          description: `Checked in ticket ${updated.code}`,
        });
        return { result: 'valid', ticket: toTicket(updated) };
      }

      const ticketResult = await client.query<TicketRow>(`${TICKET_SELECT} WHERE t.id = $1`, [
        verification.ticketId,
      ]);
      const ticket = ticketResult.rows[0];
      if (!ticket) {
        return { result: 'not_found', ticket: null };
      }
      if (ticket.event_id !== eventId) {
        return { result: 'wrong_event', ticket: null };
      }
      if (ticket.status === 'checked_in') {
        return {
          result: 'already_used',
          ticket: toTicket(ticket),
          checked_in_at: ticket.checked_in_at,
        };
      }
      if (ticket.status === 'cancelled' || ticket.status === 'refunded') {
        return { result: ticket.status, ticket: toTicket(ticket) };
      }
      throw new AppError(ErrorCode.INTERNAL_ERROR, 'Ticket status changed during check-in', 500);
    });

    res.json(outcome);
  } catch (err) {
    next(err);
  }
});

const ticketIdParamSchema = z.object({ ticket_id: z.uuid() });

checkInRouter.post('/staff/check-in/:ticket_id/undo', requireAuth, async (req, res, next) => {
  try {
    const params = ticketIdParamSchema.safeParse(req.params);
    if (!params.success) {
      throw AppError.badRequest('Ticket id must be a UUID');
    }
    const ticketId = params.data.ticket_id;
    const userId = req.user!.id;

    const ticket = await withTransaction(async (client) => {
      const lockedResult = await client.query<TicketRow>(
        `${TICKET_SELECT} WHERE t.id = $1 FOR UPDATE OF t`,
        [ticketId],
      );
      const locked = lockedResult.rows[0];
      if (!locked) {
        throw AppError.notFound(ErrorCode.TICKET_NOT_FOUND, 'Ticket not found');
      }

      await assertAssigned(locked.event_id, userId, client);
      if (locked.status !== 'checked_in') {
        throw AppError.conflict(ErrorCode.CONFLICT, 'This ticket is not checked in');
      }

      const updatedResult = await client.query<TicketRow>(
        `WITH updated AS (
           UPDATE tickets
              SET status = 'valid', checked_in_at = NULL, checked_in_by = NULL
            WHERE id = $1
            RETURNING id, code, status, attendee_name, ticket_type_id, checked_in_at, event_id
         )
         SELECT u.id,
                u.code,
                u.status,
                u.attendee_name,
                tt.name AS ticket_type_name,
                u.checked_in_at,
                u.event_id
           FROM updated u
           JOIN ticket_types tt ON tt.id = u.ticket_type_id`,
        [ticketId],
      );
      const updated = updatedResult.rows[0];
      if (!updated) {
        throw new AppError(ErrorCode.INTERNAL_ERROR, 'Failed to undo check-in', 500);
      }

      await recordAudit(client, {
        actorId: userId,
        action: 'ticket.check_in_reversed',
        entityType: 'ticket',
        entityId: ticketId,
        eventId: locked.event_id,
        description: `Undid check-in of ticket ${locked.code}`,
      });
      return toTicket(updated);
    });

    res.json({ ticket });
  } catch (err) {
    next(err);
  }
});

const eventIdParamSchema = z.object({ id: z.uuid() });

checkInRouter.get('/staff/events/:id/attendees', requireAuth, async (req, res, next) => {
  try {
    const params = eventIdParamSchema.safeParse(req.params);
    if (!params.success) {
      throw AppError.badRequest('Event id must be a UUID');
    }
    const eventId = params.data.id;
    const { limit, offset, q } = parseListQuery(req.query);

    await assertAssigned(eventId, req.user!.id);

    const search = q ? `%${escapeLike(q)}%` : null;
    const attendees = await pool.query<TicketRow>(
      `${TICKET_SELECT}
       WHERE t.event_id = $1
         AND t.status IN ('valid', 'checked_in')
         AND ($4::text IS NULL
              OR t.attendee_name ILIKE $4 ESCAPE '\\'
              OR t.code ILIKE $4 ESCAPE '\\')
       ORDER BY t.attendee_name ASC, t.id ASC
       LIMIT $2 OFFSET $3`,
      [eventId, limit, offset, search],
    );
    const counts = await pool.query<{ registered: number; checked_in: number }>(
      `SELECT count(*)::int AS registered,
              count(*) FILTER (WHERE status = 'checked_in')::int AS checked_in
         FROM tickets
        WHERE event_id = $1 AND status IN ('valid', 'checked_in')`,
      [eventId],
    );

    res.json({
      attendees: attendees.rows.map(toTicket),
      counts: counts.rows[0] ?? { registered: 0, checked_in: 0 },
      limit,
      offset,
    });
  } catch (err) {
    next(err);
  }
});
