/**
 * Organizer analytics (SRS 4.15, UC11, success criterion 10). Every number is computed
 * from orders, order items, tickets, refunds, redemptions and check-ins on each
 * request, and none is stored: a counter would drift the first time a refund or an
 * undone check-in happened (docs/decisions.md, decision 12).
 *
 * Presentation rules live here rather than in SQL, except for the day buckets, which
 * have to be grouped by the database. docs/api.md "Analytics (organizer)" is the
 * contract: revenue is the money the organizer keeps, so the 3% processing fee is
 * outside every figure, and attendance is counted from ticket status, not from the
 * audit log.
 *
 * Same layering as routes/organizer-orders.ts. Only the event's organizer reads its
 * numbers: anyone else gets 403, a missing event 404 EVENT_NOT_FOUND.
 */
import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool';
import { campaignReport } from '../lib/campaigns';
import { AppError, ErrorCode } from '../lib/errors';
import { requireAuth } from '../middleware/auth';

// Mounted at /api, because the path starts with /events like the other organizer
// routers. requireAuth goes on the route, never on router.use(): this router sees
// every /api request.
export const analyticsRouter = Router();

// Kazakhstan time, where every event in the product is and where the team is. There is
// no daylight saving to worry about, but the offset is read from Intl rather than
// hardcoded, so a rule change cannot silently shift a day boundary.
const LOCAL_ZONE = 'Asia/Almaty';

function zoneOffsetMs(instant: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: LOCAL_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');
  // The zone's wall clock read as if it were UTC, minus the instant itself: that is
  // how far ahead of UTC the zone is at that moment.
  const wallClock = Date.UTC(
    read('year'),
    read('month') - 1,
    read('day'),
    read('hour') % 24,
    read('minute'),
    read('second'),
  );
  return wallClock - instant.getTime();
}

// Midnight local time of a plain date, as an instant.
function localMidnight(date: string): Date {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(year, month - 1, day);
  // One correction pass is enough: the offset is measured at the guess, and Almaty
  // has no transition that would move midnight onto the other side of one.
  return new Date(guess - zoneOffsetMs(new Date(guess)));
}

interface Range {
  from: Date | null;
  to: Date | null;
}

const PLAIN_DATE = /^\d{4}-\d{2}-\d{2}$/;

// A plain date becomes its local midnight, a date-time with an offset is taken as it
// reads. `from` is inclusive and `to` is exclusive, so a plain date covers its whole
// local day: from its midnight to the next one (docs/api.md).
function resolveRange(from: string | undefined, to: string | undefined): Range {
  const bound = (value: string | undefined): Date | null => {
    if (!value) return null;
    return PLAIN_DATE.test(value) ? localMidnight(value) : new Date(value);
  };
  const start = bound(from);
  const end = bound(to);
  if (start && end && start >= end) {
    throw AppError.badRequest('"from" must be earlier than "to"');
  }
  return { from: start, to: end };
}

// A plain date has to be a real one: 2026-02-31 would otherwise roll over to March
// without anyone noticing.
const dateBound = z.union([
  z.iso.datetime({ offset: true }),
  z
    .string()
    .regex(PLAIN_DATE, 'expected a date like 2026-10-20, or a date-time with an offset')
    .refine((value) => new Date(`${value}T00:00:00Z`).toISOString().startsWith(value), {
      message: 'that date does not exist',
    }),
]);

const analyticsQuerySchema = z.object({
  from: dateBound.optional(),
  to: dateBound.optional(),
  ticket_type_id: z.uuid().optional(),
});

const eventIdParamSchema = z.object({ id: z.uuid() });

// One decimal, the same precision the campaign report uses. Nothing divided by zero is
// 0 rather than NaN, because an event with no capacity still has to render.
function percent(part: number, whole: number): number {
  if (whole === 0) return 0;
  return Math.round((part / whole) * 1000) / 10;
}

interface EventRow {
  id: string;
  title: string;
  status: string;
  starts_at: Date;
  organizer_id: string;
}

// 404 if the event does not exist, 403 if it is not mine. Drafts and cancelled events
// answer too: an organizer looks at the numbers before the event and after calling it
// off.
async function loadOwnEvent(eventId: string, userId: string): Promise<EventRow> {
  const result = await pool.query<EventRow>(
    `SELECT id, title, status, starts_at, organizer_id FROM events WHERE id = $1`,
    [eventId],
  );
  const event = result.rows[0];
  if (!event) {
    throw AppError.notFound(ErrorCode.EVENT_NOT_FOUND, 'Event not found');
  }
  if (event.organizer_id !== userId) {
    throw AppError.forbidden("Only the event's organizer can read its analytics");
  }
  return event;
}

interface TicketTypeRow {
  id: string;
  name: string;
  price: number;
  is_hidden: boolean;
  quantity_total: number;
}

interface TypeTotals {
  sold: number;
  held: number;
  gross: number;
  registered: number;
  checked_in: number;
}

// From here on, $1 is the event, $2 the optional ticket type, $3 and $4 the range.
// Orders are counted whole, the way they were written: an order that includes the
// filtered type counts in full, because its discount belongs to the order and not to
// one of its items.
const ORDER_FILTER = `AND ($2::uuid IS NULL
              OR EXISTS (SELECT 1
                           FROM order_items fx
                          WHERE fx.order_id = o.id AND fx.ticket_type_id = $2))
          AND ($3::timestamptz IS NULL OR o.created_at >= $3)
          AND ($4::timestamptz IS NULL OR o.created_at < $4)`;

analyticsRouter.get('/events/:id/analytics', requireAuth, async (req, res, next) => {
  try {
    const params = eventIdParamSchema.safeParse(req.params);
    if (!params.success) {
      throw AppError.badRequest('Invalid event id');
    }
    const query = analyticsQuerySchema.safeParse(req.query);
    if (!query.success) {
      const first = query.error.issues[0];
      throw AppError.badRequest(
        first ? `Invalid "${first.path.join('.')}": ${first.message}` : 'Invalid filters',
      );
    }
    const eventId = params.data.id;
    const ticketTypeId = query.data.ticket_type_id ?? null;
    const range = resolveRange(query.data.from, query.data.to);
    const event = await loadOwnEvent(eventId, req.user!.id);

    const ticketTypesResult = await pool.query<TicketTypeRow>(
      `SELECT id, name, price, is_hidden, quantity_total
         FROM ticket_types
        WHERE event_id = $1
          AND ($2::uuid IS NULL OR id = $2)
        ORDER BY price ASC, name ASC`,
      [eventId, ticketTypeId],
    );
    // A type of another event reads as missing here, and the contract says 400: the
    // parameter must not become a way to probe other events' ids.
    if (ticketTypeId && ticketTypesResult.rows.length === 0) {
      throw AppError.badRequest('That ticket type is not on this event');
    }

    const [money, itemTotals, attendance, overTime, campaigns] = await Promise.all([
      // Order level: what was collected and what came back. Refunded orders are in
      // gross and then subtracted again below, so the organizer sees both.
      pool.query<{ gross: number; discounts: number; refunds: number }>(
        `SELECT COALESCE(sum(o.subtotal), 0)::int AS gross,
                COALESCE(sum(o.discount), 0)::int AS discounts,
                COALESCE(sum(o.subtotal - o.discount) FILTER (WHERE o.status = 'refunded'), 0)::int
                  AS refunds
           FROM orders o
          WHERE o.event_id = $1
            AND o.status IN ('paid', 'refunded')
            ${ORDER_FILTER}`,
        [eventId, ticketTypeId, range.from, range.to],
      ),
      // Item level: seats sold for good, seats a pending order still holds, and what
      // the items were worth before discounts.
      pool.query<{ ticket_type_id: string; sold: number; held: number; gross: number }>(
        `SELECT oi.ticket_type_id,
                COALESCE(sum(oi.quantity) FILTER (WHERE o.status = 'paid'), 0)::int AS sold,
                COALESCE(sum(oi.quantity) FILTER (WHERE o.status = 'pending'
                          AND (o.expires_at IS NULL OR o.expires_at > now())), 0)::int AS held,
                COALESCE(sum(oi.quantity * oi.unit_price)
                          FILTER (WHERE o.status IN ('paid', 'refunded')), 0)::int AS gross
           FROM order_items oi
           JOIN orders o ON o.id = oi.order_id
          WHERE o.event_id = $1
            AND o.status IN ('paid', 'pending', 'refunded')
            AND ($2::uuid IS NULL OR oi.ticket_type_id = $2)
            AND ($3::timestamptz IS NULL OR o.created_at >= $3)
            AND ($4::timestamptz IS NULL OR o.created_at < $4)
          GROUP BY oi.ticket_type_id`,
        [eventId, ticketTypeId, range.from, range.to],
      ),
      // Attendance at the door, from ticket status: refunded and cancelled tickets are
      // neither checked in nor absent (docs/api.md).
      pool.query<{ ticket_type_id: string; registered: number; checked_in: number }>(
        `SELECT t.ticket_type_id,
                count(*) FILTER (WHERE t.status IN ('valid', 'checked_in'))::int AS registered,
                count(*) FILTER (WHERE t.status = 'checked_in')::int AS checked_in
           FROM tickets t
           JOIN order_items oi ON oi.id = t.order_item_id
           JOIN orders o ON o.id = oi.order_id
          WHERE t.event_id = $1
            AND ($2::uuid IS NULL OR t.ticket_type_id = $2)
            AND ($3::timestamptz IS NULL OR o.created_at >= $3)
            AND ($4::timestamptz IS NULL OR o.created_at < $4)
          GROUP BY t.ticket_type_id`,
        [eventId, ticketTypeId, range.from, range.to],
      ),
      // Sales over time, by the day the order was created, in local time. Only days
      // with orders appear: an empty day is visible by its missing date.
      pool.query<{
        date: string;
        orders: number;
        tickets: number;
        gross: number;
        discounts: number;
      }>(
        `SELECT to_char(date_trunc('day', o.created_at AT TIME ZONE $5), 'YYYY-MM-DD') AS date,
                count(*)::int AS orders,
                COALESCE(sum(items.tickets), 0)::int AS tickets,
                COALESCE(sum(o.subtotal), 0)::int AS gross,
                COALESCE(sum(o.discount), 0)::int AS discounts
           FROM orders o
           LEFT JOIN (SELECT order_id, sum(quantity)::int AS tickets
                        FROM order_items
                       GROUP BY order_id) items ON items.order_id = o.id
          WHERE o.event_id = $1
            AND o.status IN ('paid', 'refunded')
            ${ORDER_FILTER}
          GROUP BY 1
          ORDER BY 1`,
        [eventId, ticketTypeId, range.from, range.to, LOCAL_ZONE],
      ),
      // Campaigns are lifetime figures, so the range does not narrow them; with a
      // ticket type, only the campaigns covering it are listed.
      pool.query<{ id: string; name: string; code: string; is_active: boolean }>(
        `SELECT id, name, code, is_active
           FROM promo_campaigns
          WHERE event_id = $1
            AND ($2::uuid IS NULL OR ticket_type_ids IS NULL OR $2 = ANY (ticket_type_ids))
          ORDER BY created_at DESC`,
        [eventId, ticketTypeId],
      ),
    ]);

    const perType = new Map<string, TypeTotals>();
    for (const row of itemTotals.rows) {
      perType.set(row.ticket_type_id, {
        sold: row.sold,
        held: row.held,
        gross: row.gross,
        registered: 0,
        checked_in: 0,
      });
    }
    for (const row of attendance.rows) {
      const totals = perType.get(row.ticket_type_id) ?? {
        sold: 0,
        held: 0,
        gross: 0,
        registered: 0,
        checked_in: 0,
      };
      totals.registered = row.registered;
      totals.checked_in = row.checked_in;
      perType.set(row.ticket_type_id, totals);
    }

    const byTicketType = ticketTypesResult.rows.map((type) => {
      const totals = perType.get(type.id) ?? {
        sold: 0,
        held: 0,
        gross: 0,
        registered: 0,
        checked_in: 0,
      };
      return {
        ticket_type_id: type.id,
        name: type.name,
        price: type.price,
        is_hidden: type.is_hidden,
        capacity: type.quantity_total,
        sold: totals.sold,
        remaining: type.quantity_total - totals.sold,
        gross: totals.gross,
        registered: totals.registered,
        checked_in: totals.checked_in,
        absent: totals.registered - totals.checked_in,
      };
    });

    const capacity = byTicketType.reduce((sum, type) => sum + type.capacity, 0);
    const sold = byTicketType.reduce((sum, type) => sum + type.sold, 0);
    const held = [...perType.values()].reduce((sum, totals) => sum + totals.held, 0);
    const registered = byTicketType.reduce((sum, type) => sum + type.registered, 0);
    const checkedIn = byTicketType.reduce((sum, type) => sum + type.checked_in, 0);
    const moneyRow = money.rows[0] ?? { gross: 0, discounts: 0, refunds: 0 };

    res.json({
      event: {
        id: event.id,
        title: event.title,
        status: event.status,
        starts_at: event.starts_at,
      },
      filters: {
        from: query.data.from ?? null,
        to: query.data.to ?? null,
        ticket_type_id: ticketTypeId,
      },
      sales: {
        capacity,
        held,
        sold,
        remaining: capacity - sold,
        percent_sold: percent(sold, capacity),
      },
      revenue: {
        currency: 'KZT',
        is_demonstration: true,
        gross: moneyRow.gross,
        discounts: moneyRow.discounts,
        refunds: moneyRow.refunds,
        net: moneyRow.gross - moneyRow.discounts - moneyRow.refunds,
      },
      by_ticket_type: byTicketType,
      check_in: {
        registered,
        checked_in: checkedIn,
        absent: registered - checkedIn,
        percent: percent(checkedIn, registered),
      },
      over_time: overTime.rows.map((row) => ({
        date: row.date,
        orders: row.orders,
        tickets: row.tickets,
        gross: row.gross,
        discounts: row.discounts,
        net: row.gross - row.discounts,
      })),
      campaigns: await Promise.all(
        campaigns.rows.map(async (campaign) => ({
          id: campaign.id,
          name: campaign.name,
          code: campaign.code,
          is_active: campaign.is_active,
          ...(await campaignReport(pool, campaign.id)),
        })),
      ),
    });
  } catch (err) {
    next(err);
  }
});
