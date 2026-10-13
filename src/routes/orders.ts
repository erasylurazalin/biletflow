/**
 * Orders: buy tickets, pay for them, read my orders. Same layering as routes/events.ts.
 *
 * Two steps, as docs/api.md asks. POST /api/orders holds the seats for 10 minutes as a
 * pending order. POST /api/orders/:id/pay marks it paid and issues one ticket per seat.
 * A free order goes through the same two steps with a total of 0. Paid sales activation
 * (SRS 4.5) is not built yet, so for now /pay is a simulation: it takes no payment
 * details and always succeeds on a pending order.
 *
 * Inventory is never stored (migration 001). Seats are "held" by paid orders and by
 * pending orders that have not expired (HELD_SQL), so an expired order gives its seats
 * back without anybody having to sweep it.
 *
 * Overselling is prevented by locking. Placing an order locks the rows of the ticket
 * types it buys (SELECT ... FOR UPDATE), and only then counts what is held. Two buyers of
 * the same ticket type therefore take turns: the second one counts after the first has
 * committed, and sees its seats as taken. src/routes/orders.db.test.ts proves this
 * against a real database.
 *
 * Orders belong to the buyer. Somebody else's order is 404, never 403, so order ids
 * cannot be probed.
 */
import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { pool } from '../db/pool';
import { withTransaction } from '../db/transaction';
import { AppError, ErrorCode } from '../lib/errors';
import { requireAuth } from '../middleware/auth';
import { HELD_SQL } from './ticket-types';
import { TICKET_SELECT, toTicket, type TicketRow } from './tickets';

export const ordersRouter = Router();

// SRS 4.3 asks for a per-order limit. 10 is our default until organizers can set one.
const MAX_TICKETS_PER_ORDER = 10;

// Postgres error code for a foreign key violation: the user behind the token is gone.
const PG_FOREIGN_KEY_VIOLATION = '23503';

// A pending order past expires_at holds nothing and reads as cancelled (docs/api.md).
// Computed on every read instead of written by a background job, so it is right the
// moment the order expires. Constant SQL, safe to put in with ${}.
const ORDER_STATUS_SQL = `CASE WHEN o.status = 'pending' AND o.expires_at <= now()
                               THEN 'cancelled' ELSE o.status END`;

const ORDER_SELECT = `SELECT o.id,
         ${ORDER_STATUS_SQL} AS status,
         o.event_id,
         e.title AS event_title,
         o.subtotal,
         o.discount,
         o.total,
         o.created_at,
         o.expires_at
    FROM orders o
    JOIN events e ON e.id = o.event_id`;

interface OrderRow {
  id: string;
  status: string;
  event_id: string;
  event_title: string;
  subtotal: number;
  discount: number;
  total: number;
  created_at: Date;
  expires_at: Date | null;
}

interface OrderItemRow {
  order_id: string;
  ticket_type_id: string;
  name: string;
  quantity: number;
  unit_price: number;
}

// docs/api.md "order" object. `tickets` is left out of list items.
function toOrder(row: OrderRow, items: OrderItemRow[], tickets?: TicketRow[]) {
  return {
    id: row.id,
    status: row.status,
    event: { id: row.event_id, title: row.event_title },
    items: items
      .filter((item) => item.order_id === row.id)
      .map((item) => ({
        ticket_type_id: item.ticket_type_id,
        name: item.name,
        quantity: item.quantity,
        unit_price: item.unit_price,
      })),
    subtotal: row.subtotal,
    discount: row.discount,
    total: row.total,
    created_at: row.created_at,
    expires_at: row.expires_at,
    ...(tickets && { tickets: tickets.map(toTicket) }),
  };
}

async function loadItems(orderIds: string[]): Promise<OrderItemRow[]> {
  if (orderIds.length === 0) {
    return [];
  }
  const result = await pool.query<OrderItemRow>(
    `SELECT order_id, ticket_type_id, name, quantity, unit_price
       FROM order_items
      WHERE order_id = ANY($1::uuid[])
      ORDER BY name ASC`,
    [orderIds],
  );
  return result.rows;
}

// One of my orders with its items and tickets, or 404.
async function loadOrder(orderId: string, userId: string) {
  const result = await pool.query<OrderRow>(
    `${ORDER_SELECT}
      WHERE o.id = $1
        AND o.user_id = $2`,
    [orderId, userId],
  );
  const row = result.rows[0];
  if (!row) {
    throw orderNotFound();
  }
  const items = await loadItems([row.id]);
  const tickets = await pool.query<TicketRow>(
    `${TICKET_SELECT}
      WHERE o.id = $1
      ORDER BY oi.name ASC, t.code ASC`,
    [row.id],
  );
  return toOrder(row, items, tickets.rows);
}

function orderNotFound(): AppError {
  return AppError.notFound(ErrorCode.ORDER_NOT_FOUND, 'Order not found');
}

function badRequestFrom(error: z.ZodError, what: string): AppError {
  const first = error.issues[0];
  if (!first) {
    return AppError.badRequest(`Invalid ${what}`);
  }
  // Rules over the whole body (the per-order limit, duplicates) have no field to name.
  return AppError.badRequest(
    first.path.length > 0
      ? `Invalid ${what} "${first.path.join('.')}": ${first.message}`
      : first.message,
  );
}

const idParamSchema = z.object({ id: z.uuid() });

// Same paging as GET /api/events (docs/api.md "List responses").
const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

// The printed code on a ticket, BF-XXXX-XXXX. The alphabet leaves out 0, O, 1 and I so
// door staff typing it by hand cannot confuse them. 32 letters, so `byte % 32` picks
// each one without bias. 40 random bits make a collision between two tickets unlikely
// enough to ignore at our size; if one ever happens, the UNIQUE constraint on
// tickets.code fails that payment and the buyer pays again.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function ticketCode(): string {
  const chars = [...randomBytes(8)].map((byte) => CODE_ALPHABET[byte % 32]).join('');
  return `BF-${chars.slice(0, 4)}-${chars.slice(4)}`;
}

// ---------------------------------------------------------------------------
// POST /api/orders  - hold seats for 10 minutes
// ---------------------------------------------------------------------------

const createSchema = z
  .object({
    event_id: z.uuid(),
    items: z
      .array(
        z.object({
          ticket_type_id: z.uuid(),
          quantity: z.number().int().min(1).max(MAX_TICKETS_PER_ORDER),
        }),
      )
      .min(1),
  })
  .refine(
    (v) => new Set(v.items.map((item) => item.ticket_type_id)).size === v.items.length,
    'Each ticket type can appear only once in an order',
  )
  .refine(
    (v) => v.items.reduce((sum, item) => sum + item.quantity, 0) <= MAX_TICKETS_PER_ORDER,
    `An order can have at most ${MAX_TICKETS_PER_ORDER} tickets`,
  );

interface LockedTicketTypeRow {
  id: string;
  event_id: string;
  name: string;
  price: number;
  is_hidden: boolean;
  on_sale: boolean;
}

ordersRouter.post('/', requireAuth, async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequestFrom(parsed.error, 'field');
    }
    const { event_id: eventId, items } = parsed.data;
    const ticketTypeIds = items.map((item) => item.ticket_type_id);

    const orderId = await withTransaction(async (client) => {
      const eventResult = await client.query<{ status: string }>(
        `SELECT status FROM events WHERE id = $1`,
        [eventId],
      );
      const event = eventResult.rows[0];
      // A draft is 404, the same as the public detail: nobody else may know it exists.
      if (!event || event.status === 'draft') {
        throw AppError.notFound(ErrorCode.EVENT_NOT_FOUND, 'Event not found');
      }
      if (event.status === 'cancelled') {
        throw AppError.conflict(ErrorCode.CONFLICT, 'This event has been cancelled');
      }

      // The lock. Ordered by id, so two orders for the same pair of ticket types take
      // the locks in the same order and queue up instead of deadlocking. Held until the
      // transaction ends. Editing a ticket type (PATCH) waits for it too.
      //
      // The sales window: no sales_start_at means on sale from the start, no
      // sales_end_at means on sale until the event starts (migration 001).
      const typesResult = await client.query<LockedTicketTypeRow>(
        `SELECT tt.id,
                tt.event_id,
                tt.name,
                tt.price,
                tt.is_hidden,
                now() >= COALESCE(tt.sales_start_at, '-infinity')
                  AND now() < COALESCE(tt.sales_end_at, e.starts_at) AS on_sale
           FROM ticket_types tt
           JOIN events e ON e.id = tt.event_id
          WHERE tt.id = ANY($1::uuid[])
          ORDER BY tt.id
            FOR UPDATE OF tt`,
        [ticketTypeIds],
      );
      const types = new Map(typesResult.rows.map((row) => [row.id, row]));

      for (const item of items) {
        const type = types.get(item.ticket_type_id);
        // Hidden types are for promo codes, which do not exist yet. Saying "hidden"
        // would reveal that the type exists, so all three cases read the same.
        if (!type || type.event_id !== eventId || type.is_hidden) {
          throw AppError.badRequest(
            `Ticket type ${item.ticket_type_id} is not on sale for this event`,
          );
        }
      }
      for (const item of items) {
        const type = types.get(item.ticket_type_id)!;
        if (!type.on_sale) {
          throw AppError.conflict(
            ErrorCode.SALES_CLOSED,
            `"${type.name}" tickets are not on sale right now`,
          );
        }
      }

      // Counted in its own statement, after the lock is granted, on purpose. Postgres
      // gives every statement a fresh view of committed data, so this one sees the
      // order of whoever held the lock before us. Counting inside the SELECT ... FOR
      // UPDATE above would use the view from before we waited, and oversell.
      const availableResult = await client.query<{ id: string; available: number }>(
        `SELECT tt.id, tt.quantity_total - ${HELD_SQL} AS available
           FROM ticket_types tt
          WHERE tt.id = ANY($1::uuid[])`,
        [ticketTypeIds],
      );
      const available = new Map(availableResult.rows.map((row) => [row.id, row.available]));
      for (const item of items) {
        const left = available.get(item.ticket_type_id) ?? 0;
        if (item.quantity > left) {
          const name = types.get(item.ticket_type_id)!.name;
          throw AppError.conflict(
            ErrorCode.TICKET_SOLD_OUT,
            left === 0
              ? `"${name}" is sold out`
              : `Only ${left} "${name}" ${left === 1 ? 'ticket is' : 'tickets are'} left`,
          );
        }
      }

      // name and unit_price are copied, so a later price change does not touch this
      // order. discount stays 0 until promo codes exist.
      const subtotal = items.reduce(
        (sum, item) => sum + item.quantity * types.get(item.ticket_type_id)!.price,
        0,
      );

      let orderResult;
      try {
        // requireAuth guarantees req.user.
        orderResult = await client.query<{ id: string }>(
          `INSERT INTO orders (user_id, event_id, status, subtotal, discount, total, expires_at)
           VALUES ($1, $2, 'pending', $3, 0, $3, now() + interval '10 minutes')
           RETURNING id`,
          [req.user!.id, eventId, subtotal],
        );
      } catch (err) {
        if ((err as { code?: string }).code === PG_FOREIGN_KEY_VIOLATION) {
          // Valid token for a user that has since been deleted.
          throw AppError.unauthorized();
        }
        throw err;
      }
      const newOrderId = orderResult.rows[0]!.id;

      await client.query(
        `INSERT INTO order_items (order_id, ticket_type_id, name, quantity, unit_price)
         SELECT $1, tt.id, tt.name, item.quantity, tt.price
           FROM unnest($2::uuid[], $3::int[]) AS item (ticket_type_id, quantity)
           JOIN ticket_types tt ON tt.id = item.ticket_type_id`,
        [newOrderId, ticketTypeIds, items.map((item) => item.quantity)],
      );

      return newOrderId;
    });

    res.status(201).json({ order: await loadOrder(orderId, req.user!.id) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/orders/:id/pay  - simulated payment, issues the tickets
// ---------------------------------------------------------------------------

interface PayItemRow {
  id: string;
  ticket_type_id: string;
  quantity: number;
}

async function issueTickets(
  client: PoolClient,
  orderId: string,
  eventId: string,
  attendeeName: string,
  items: PayItemRow[],
): Promise<void> {
  // One ticket per seat: an item with quantity 2 gives two tickets.
  const seats = items.flatMap((item) => Array.from({ length: item.quantity }, () => item));
  await client.query(
    `INSERT INTO tickets (order_item_id, event_id, ticket_type_id, code, attendee_name)
     SELECT seat.order_item_id, $1, seat.ticket_type_id, seat.code, $2
       FROM unnest($3::uuid[], $4::uuid[], $5::text[])
            AS seat (order_item_id, ticket_type_id, code)`,
    [
      eventId,
      attendeeName,
      seats.map((seat) => seat.id),
      seats.map((seat) => seat.ticket_type_id),
      seats.map(() => ticketCode()),
    ],
  );
}

ordersRouter.post('/:id/pay', requireAuth, async (req, res, next) => {
  try {
    const parsed = idParamSchema.safeParse(req.params);
    if (!parsed.success) {
      throw AppError.badRequest('Order id must be a UUID');
    }
    const orderId = parsed.data.id;
    const userId = req.user!.id;

    await withTransaction(async (client) => {
      // Locking the order makes a double click on "Pay" issue tickets once: the second
      // request waits here, then finds the order already paid.
      const orderResult = await client.query<{ status: string; event_id: string }>(
        `SELECT status, event_id FROM orders WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [orderId, userId],
      );
      const order = orderResult.rows[0];
      if (!order) {
        throw orderNotFound();
      }
      if (order.status !== 'pending') {
        throw AppError.conflict(ErrorCode.CONFLICT, `This order is already ${order.status}`);
      }

      const itemsResult = await client.query<PayItemRow>(
        `SELECT id, ticket_type_id, quantity FROM order_items WHERE order_id = $1`,
        [orderId],
      );

      // Same locks, in the same order, as placing an order. Without them, a payment in
      // the last second before expiry could race a new buyer who already counts these
      // seats as free. With them, whichever comes second sees what the first did.
      await client.query(
        `SELECT id FROM ticket_types WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
        [itemsResult.rows.map((item) => item.ticket_type_id)],
      );

      // clock_timestamp(), not now(): now() is when this transaction began, and we may
      // have waited for the locks since.
      const expiredResult = await client.query<{ expired: boolean }>(
        `SELECT expires_at <= clock_timestamp() AS expired FROM orders WHERE id = $1`,
        [orderId],
      );
      if (expiredResult.rows[0]!.expired) {
        throw AppError.conflict(
          ErrorCode.ORDER_EXPIRED,
          'This order expired and its seats were released. Place a new order.',
        );
      }

      // A paid order never expires, so expires_at goes (the seeded paid order agrees).
      await client.query(`UPDATE orders SET status = 'paid', expires_at = NULL WHERE id = $1`, [
        orderId,
      ]);

      // SRS 4.6 wants attendee details at checkout. Until the request body has them,
      // every ticket carries the buyer's account name (docs/api.md).
      const userResult = await client.query<{ name: string }>(
        `SELECT name FROM users WHERE id = $1`,
        [userId],
      );
      await issueTickets(
        client,
        orderId,
        order.event_id,
        userResult.rows[0]!.name,
        itemsResult.rows,
      );
    });

    res.json({ order: await loadOrder(orderId, userId) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/orders  - my orders, newest first
// ---------------------------------------------------------------------------

ordersRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw badRequestFrom(parsed.error, 'query parameter');
    }
    const { limit, offset } = parsed.data;

    const result = await pool.query<OrderRow>(
      `${ORDER_SELECT}
        WHERE o.user_id = $1
        ORDER BY o.created_at DESC, o.id
        LIMIT $2 OFFSET $3`,
      [req.user!.id, limit, offset],
    );
    const items = await loadItems(result.rows.map((row) => row.id));

    // List items leave out tickets (docs/api.md); GET /api/orders/:id has them.
    res.json({ orders: result.rows.map((row) => toOrder(row, items)), limit, offset });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/orders/:id  - one of my orders, with its tickets
// ---------------------------------------------------------------------------

ordersRouter.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const parsed = idParamSchema.safeParse(req.params);
    if (!parsed.success) {
      throw AppError.badRequest('Order id must be a UUID');
    }

    res.json({ order: await loadOrder(parsed.data.id, req.user!.id) });
  } catch (err) {
    next(err);
  }
});
