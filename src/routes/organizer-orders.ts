/**
 * Organizer endpoints for orders: list an event's orders, refund a paid one, cancel a
 * free registration. Same layering as routes/events.ts.
 *
 * Refunds and cancellations are always full and always started here, by the event's
 * organizer (docs/decisions.md, decision 10). A paid order with a total above 0 is
 * refunded; a paid order with total 0 (a free registration) is cancelled, because there
 * is nothing to refund. Using the wrong endpoint for the order is 409 with a message
 * that points at the right one.
 *
 * Seats are never given back by hand: inventory counts paid and live pending orders
 * (HELD_SQL in routes/ticket-types.ts), so an order that becomes refunded or cancelled
 * releases its seats by changing status and nothing else.
 *
 * A refund records a row in the refunds table (migration 008), one per order, inside
 * the same transaction as the audit entry and the buyer's email, so all three commit
 * or roll back together. The order row is locked FOR UPDATE first, so two refunds of
 * one order take turns and the second one finds the order already refunded.
 *
 * A ticket that was already used at the door blocks the whole action: the organizer
 * should not be able to silently invalidate a wristband somebody is wearing.
 */
import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool';
import { withTransaction } from '../db/transaction';
import { recordAudit } from '../lib/audit';
import { AppError, ErrorCode } from '../lib/errors';
import { sendEmail } from '../lib/mailer';
import { REFUND_COLUMNS, toRefund, type RefundColumns } from '../lib/refunds';
import { requireAuth } from '../middleware/auth';

// Mounted at /api, because the paths start with /events like the other organizer
// routers. requireAuth goes on each route, never on router.use(): this router sees
// every /api request, and the public ones must not demand a token.
export const organizerOrdersRouter = Router();

function badRequestFrom(error: z.ZodError, what: string): AppError {
  const first = error.issues[0];
  return AppError.badRequest(
    first ? `Invalid ${what} "${first.path.join('.')}": ${first.message}` : `Invalid ${what}`,
  );
}

const eventIdParamSchema = z.object({ id: z.uuid() });
const orderParamsSchema = z.object({ id: z.uuid(), orderId: z.uuid() });

// Same paging as GET /api/events (docs/api.md "List responses").
const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.enum(['pending', 'paid', 'cancelled', 'refunded']).optional(),
});

interface EventOwnerRow {
  organizer_id: string;
  title: string;
  refund_policy: string | null;
}

// 404 if the event does not exist, 403 if it is not mine. Everything below sits
// behind this, so an unknown event and a foreign event read the same up to here.
async function loadOwnEvent(eventId: string, userId: string): Promise<EventOwnerRow> {
  const result = await pool.query<EventOwnerRow>(
    `SELECT organizer_id, title, refund_policy FROM events WHERE id = $1`,
    [eventId],
  );
  const event = result.rows[0];
  if (!event) {
    throw AppError.notFound(ErrorCode.EVENT_NOT_FOUND, 'Event not found');
  }
  if (event.organizer_id !== userId) {
    throw AppError.forbidden("Only the event's organizer can manage its orders");
  }
  return event;
}

interface OrganizerOrderRow extends RefundColumns {
  id: string;
  status: string;
  subtotal: number;
  discount: number;
  processing_fee: number;
  total: number;
  created_at: Date;
  buyer_id: string;
  buyer_name: string;
  buyer_email: string;
  ticket_count: number;
  checked_in_count: number;
}

// docs/api.md "order" object, organizer view: the buyer instead of the items, counts
// instead of the tickets themselves, and the refund when there is one.
function toOrganizerOrder(row: OrganizerOrderRow) {
  return {
    id: row.id,
    status: row.status,
    buyer: { id: row.buyer_id, name: row.buyer_name, email: row.buyer_email },
    subtotal: row.subtotal,
    discount: row.discount,
    processing_fee: row.processing_fee,
    total: row.total,
    ticket_count: row.ticket_count,
    checked_in_count: row.checked_in_count,
    created_at: row.created_at,
    refund: toRefund(row),
  };
}

// One order of the event with buyer, counts and refund, or 404 when the order is not
// the event's: an order reached through the wrong event's URL reads as missing, the
// same as the attendee endpoints.
const ORDER_SELECT = `SELECT o.id,
         o.status,
         o.subtotal,
         o.discount,
         o.processing_fee,
         o.total,
         o.created_at,
         u.id   AS buyer_id,
         u.name AS buyer_name,
         u.email AS buyer_email,
         count(t.id)::int AS ticket_count,
         count(t.id) FILTER (WHERE t.status = 'checked_in')::int AS checked_in_count,
         ${REFUND_COLUMNS}
    FROM orders o
    JOIN users u ON u.id = o.user_id
    LEFT JOIN order_items oi ON oi.order_id = o.id
    LEFT JOIN tickets t ON t.order_item_id = oi.id
    LEFT JOIN refunds rf ON rf.order_id = o.id`;

async function loadOrganizerOrder(eventId: string, orderId: string) {
  const result = await pool.query<OrganizerOrderRow>(
    `${ORDER_SELECT}
      WHERE o.id = $2 AND o.event_id = $1
      GROUP BY o.id, u.id, rf.id`,
    [eventId, orderId],
  );
  const row = result.rows[0];
  if (!row) {
    throw AppError.notFound(ErrorCode.ORDER_NOT_FOUND, 'Order not found');
  }
  return toOrganizerOrder(row);
}

// ---------------------------------------------------------------------------
// GET /api/events/:id/orders  - my event's orders, newest first
// ---------------------------------------------------------------------------

organizerOrdersRouter.get('/events/:id/orders', requireAuth, async (req, res, next) => {
  try {
    const params = eventIdParamSchema.safeParse(req.params);
    if (!params.success) {
      throw AppError.badRequest('Event id must be a UUID');
    }
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw badRequestFrom(parsed.error, 'query parameter');
    }
    const { limit, offset, status } = parsed.data;
    const eventId = params.data.id;

    await loadOwnEvent(eventId, req.user!.id);

    const result = await pool.query<OrganizerOrderRow>(
      `${ORDER_SELECT}
        WHERE o.event_id = $3
          AND ($4::text IS NULL OR o.status = $4)
        GROUP BY o.id, u.id, rf.id
        ORDER BY o.created_at DESC, o.id
        LIMIT $1 OFFSET $2`,
      [limit, offset, eventId, status ?? null],
    );

    res.json({ orders: result.rows.map(toOrganizerOrder), limit, offset });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/events/:id/orders/:orderId/refund  - full simulated refund of a paid order
// POST /api/events/:id/orders/:orderId/cancel  - cancel a free registration
// ---------------------------------------------------------------------------

interface LockedOrderRow {
  status: string;
  total: number;
  user_id: string;
  buyer_email: string;
  checked_in_count: number;
  ticket_count: number;
}

// Both endpoints share everything up to the status checks; refund and cancel only
// differ in the rows they write.
async function changeOrder(
  eventId: string,
  orderId: string,
  action: 'refund' | 'cancel',
  organizerId: string,
): Promise<void> {
  const event = await loadOwnEvent(eventId, organizerId);

  await withTransaction(async (client) => {
    // Lock the order's tickets first, so a door scan cannot slip in between counting
    // checked-in tickets and changing them: a scan waits for this transaction, and the
    // count below (a new statement, so a fresh snapshot) sees any scan that won.
    await client.query(
      `SELECT t.id FROM tickets t
         JOIN order_items oi ON oi.id = t.order_item_id
        WHERE oi.order_id = $1
        ORDER BY t.id
        FOR UPDATE OF t`,
      [orderId],
    );

    // The lock. Two simultaneous refunds queue up here: the second one waits, then
    // finds the order already refunded and gets the 409 below.
    const orderResult = await client.query<LockedOrderRow>(
      `SELECT o.status,
              o.total,
              o.user_id,
              u.email AS buyer_email,
              (SELECT count(*)::int FROM tickets t
                JOIN order_items oi ON oi.id = t.order_item_id
               WHERE oi.order_id = o.id AND t.status = 'checked_in') AS checked_in_count,
              (SELECT count(*)::int FROM tickets t
                JOIN order_items oi ON oi.id = t.order_item_id
               WHERE oi.order_id = o.id) AS ticket_count
         FROM orders o
         JOIN users u ON u.id = o.user_id
        WHERE o.id = $1 AND o.event_id = $2
        FOR UPDATE OF o`,
      [orderId, eventId],
    );
    const order = orderResult.rows[0];
    if (!order) {
      throw AppError.notFound(ErrorCode.ORDER_NOT_FOUND, 'Order not found');
    }
    if (order.status !== 'paid') {
      const done = action === 'refund' ? 'refunded' : 'cancelled';
      throw AppError.conflict(
        ErrorCode.CONFLICT,
        `Only paid orders can be ${done}. This order is ${order.status}.`,
      );
    }
    if (order.checked_in_count > 0) {
      throw AppError.conflict(
        ErrorCode.CONFLICT,
        'Some tickets of this order were already used at the door',
      );
    }
    // The other endpoint is the right one for this order. Point at it, so the
    // organizer's client can offer the correct action.
    if (action === 'refund' && order.total === 0) {
      throw AppError.conflict(
        ErrorCode.CONFLICT,
        'This order is a free registration. Cancel it instead of refunding it.',
      );
    }
    if (action === 'cancel' && order.total > 0) {
      throw AppError.conflict(
        ErrorCode.CONFLICT,
        'This order was paid. Refund it instead of cancelling it.',
      );
    }

    if (action === 'refund') {
      const formatted = (order.total / 100).toFixed(2);
      await client.query(`UPDATE orders SET status = 'refunded' WHERE id = $1`, [orderId]);
      // Cancelled tickets of a cancelled event refund too: the organizer can still
      // give paid orders their money back after the event is called off.
      await client.query(
        `UPDATE tickets SET status = 'refunded'
          WHERE status IN ('valid', 'cancelled')
            AND order_item_id IN (SELECT id FROM order_items WHERE order_id = $1)`,
        [orderId],
      );
      await client.query(
        `INSERT INTO refunds (order_id, refunded_by, amount, method)
         VALUES ($1, $2, $3, 'simulated')`,
        [orderId, organizerId, order.total],
      );
      await recordAudit(client, {
        actorId: organizerId,
        action: 'order.refunded',
        entityType: 'order',
        entityId: orderId,
        eventId,
        description: `Refunded ${formatted} KZT (simulated)`,
      });
      await sendEmail(client, {
        userId: order.user_id,
        to: order.buyer_email,
        kind: 'refund_completed',
        subject: `Your refund for ${event.title}`,
        body: [
          `Your refund for ${event.title} is complete: ${formatted} KZT.`,
          'This is a simulated refund for the academic MVP. No real money moves.',
          ...(event.refund_policy ? [`Refund policy: ${event.refund_policy}`] : []),
        ].join('\n'),
      });
    } else {
      await client.query(`UPDATE orders SET status = 'cancelled' WHERE id = $1`, [orderId]);
      await client.query(
        `UPDATE tickets SET status = 'cancelled'
          WHERE status = 'valid'
            AND order_item_id IN (SELECT id FROM order_items WHERE order_id = $1)`,
        [orderId],
      );
      await recordAudit(client, {
        actorId: organizerId,
        action: 'order.cancelled',
        entityType: 'order',
        entityId: orderId,
        eventId,
        description: `Cancelled a free registration of ${order.ticket_count} tickets`,
      });
      await sendEmail(client, {
        userId: order.user_id,
        to: order.buyer_email,
        kind: 'registration_cancelled',
        subject: `Your registration for ${event.title} was cancelled`,
        body: [
          `Your free registration for ${event.title} was cancelled by the organizer.`,
          `Its ${order.ticket_count} ${
            order.ticket_count === 1 ? 'ticket is' : 'tickets are'
          } no longer valid.`,
        ].join('\n'),
      });
    }
  });
}

organizerOrdersRouter.post(
  '/events/:id/orders/:orderId/refund',
  requireAuth,
  async (req, res, next) => {
    try {
      const params = orderParamsSchema.safeParse(req.params);
      if (!params.success) {
        throw AppError.badRequest('Event and order ids must be UUIDs');
      }
      await changeOrder(params.data.id, params.data.orderId, 'refund', req.user!.id);
      res.json({ order: await loadOrganizerOrder(params.data.id, params.data.orderId) });
    } catch (err) {
      next(err);
    }
  },
);

organizerOrdersRouter.post(
  '/events/:id/orders/:orderId/cancel',
  requireAuth,
  async (req, res, next) => {
    try {
      const params = orderParamsSchema.safeParse(req.params);
      if (!params.success) {
        throw AppError.badRequest('Event and order ids must be UUIDs');
      }
      await changeOrder(params.data.id, params.data.orderId, 'cancel', req.user!.id);
      res.json({ order: await loadOrganizerOrder(params.data.id, params.data.orderId) });
    } catch (err) {
      next(err);
    }
  },
);
