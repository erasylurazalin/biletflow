/**
 * Organizer event history (SRS 4.16, UC12, success criterion 11): the authorized
 * activity timeline of an event, and duplicating a past event into a new draft.
 *
 * Same layering as routes/events.ts. The timeline reads the append-only audit_log
 * written by recordAudit(); it never writes or edits entries. The duplicate copies
 * reusable configuration only: no orders, tickets, payments, refunds, check-ins, promo
 * campaigns, staff, paid-sales activation or suspension travel with it.
 *
 * Mounted at /api because the paths start with /events. requireAuth goes on each route,
 * never on router.use(): this router sees every /api request.
 */
import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool';
import { withTransaction } from '../db/transaction';
import { AUDIT_ACTIONS, recordAudit } from '../lib/audit';
import { AppError, ErrorCode } from '../lib/errors';
import { requireAuth } from '../middleware/auth';

export const eventHistoryRouter = Router();

const eventIdParamSchema = z.object({ id: z.uuid() });

// ---------------------------------------------------------------------------
// Timeline date range
// ---------------------------------------------------------------------------

// Kazakhstan time, where every event in the product is. Same choice as analytics: a
// plain date means that local day, not the server's day.
const LOCAL_ZONE = 'Asia/Almaty';
const PLAIN_DATE = /^\d{4}-\d{2}-\d{2}$/;

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

// Midnight local time of a plain date, shifted by whole days. `to` needs the next
// midnight because the day it names is inclusive.
function localMidnight(date: string, addDays = 0): Date {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(year, month - 1, day + addDays);
  return new Date(guess - zoneOffsetMs(new Date(guess)));
}

// A plain date has to be a real one: 2026-02-31 would otherwise roll over to March
// without anyone noticing.
const dateBound = z.union([
  z.iso.datetime({ offset: true }),
  z
    .string()
    .regex(PLAIN_DATE, 'expected a date like 2026-10-20, or a date-time with an offset')
    .refine(
      (value) => {
        const parsed = new Date(`${value}T00:00:00Z`);
        return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
      },
      { message: 'that date does not exist' },
    ),
]);

interface Range {
  from: Date | null;
  to: Date | null;
}

// `from` is inclusive and `to` is inclusive too: a plain date covers its whole local
// day, a date-time covers that exact instant (docs/api.md, "Event history").
function resolveRange(from: string | undefined, to: string | undefined): Range {
  const start = from ? (PLAIN_DATE.test(from) ? localMidnight(from) : new Date(from)) : null;
  const end = to
    ? PLAIN_DATE.test(to)
      ? localMidnight(to, 1)
      : new Date(new Date(to).getTime() + 1)
    : null;
  if (start && end && start >= end) {
    throw AppError.badRequest('"from" must not be later than "to"');
  }
  return { from: start, to: end };
}

const timelineQuerySchema = z.object({
  from: dateBound.optional(),
  to: dateBound.optional(),
  action: z.enum(AUDIT_ACTIONS).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

interface AccessRow {
  organizer_id: string;
  is_staff: boolean;
}

interface TimelineRow {
  id: string;
  created_at: Date;
  action: string;
  entity_type: string;
  entity_id: string;
  description: string;
  actor_id: string | null;
  actor_name: string | null;
}

// docs/api.md "Audit entry". An entry whose actor account is gone keeps its text but
// loses the actor object: the audit row has no foreign key, on purpose.
function toTimelineEntry(row: TimelineRow) {
  return {
    id: row.id,
    created_at: row.created_at,
    action: row.action,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    description: row.description,
    actor:
      row.actor_id === null ? null : { id: row.actor_id, name: row.actor_name ?? 'Unknown user' },
  };
}

// ---------------------------------------------------------------------------
// GET /api/events/:id/timeline  - the event's audit trail
// ---------------------------------------------------------------------------

eventHistoryRouter.get('/events/:id/timeline', requireAuth, async (req, res, next) => {
  try {
    const params = eventIdParamSchema.safeParse(req.params);
    if (!params.success) {
      throw AppError.badRequest('Event id must be a UUID');
    }
    const parsed = timelineQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw AppError.badRequest(
        first
          ? `Invalid query parameter "${first.path.join('.')}": ${first.message}`
          : 'Invalid query',
      );
    }
    const { action, limit, offset } = parsed.data;
    const range = resolveRange(parsed.data.from, parsed.data.to);
    const eventId = params.data.id;

    // Every status answers, including cancelled and suspended events. The organizer,
    // the event's door staff and platform admins may read it. Everyone else and unknown
    // ids look the same: 404 EVENT_NOT_FOUND, so the route cannot be used to probe ids.
    const access = await pool.query<AccessRow>(
      `SELECT e.organizer_id,
              EXISTS (SELECT 1
                        FROM event_staff s
                       WHERE s.event_id = e.id AND s.user_id = $2) AS is_staff
         FROM events e
        WHERE e.id = $1`,
      [eventId, req.user!.id],
    );
    const event = access.rows[0];
    if (
      !event ||
      (req.user!.role !== 'platform_admin' &&
        event.organizer_id !== req.user!.id &&
        !event.is_staff)
    ) {
      throw AppError.notFound(ErrorCode.EVENT_NOT_FOUND, 'Event not found');
    }

    const entries = await pool.query<TimelineRow>(
      `SELECT a.id,
              a.created_at,
              a.action,
              a.entity_type,
              a.entity_id,
              a.description,
              u.id   AS actor_id,
              u.name AS actor_name
         FROM audit_log a
         LEFT JOIN users u ON u.id = a.actor_id
        WHERE a.event_id = $1
          AND ($2::timestamptz IS NULL OR a.created_at >= $2)
          AND ($3::timestamptz IS NULL OR a.created_at < $3)
          AND ($4::text IS NULL OR a.action = $4)
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT $5 OFFSET $6`,
      [eventId, range.from, range.to, action ?? null, limit, offset],
    );

    // The filter offers only actions this event actually has. The list is for the whole
    // event, not the current date range, so narrowing the dates does not empty the menu.
    const actions = await pool.query<{ action: string }>(
      `SELECT DISTINCT action
         FROM audit_log
        WHERE event_id = $1
        ORDER BY action ASC`,
      [eventId],
    );

    res.json({
      entries: entries.rows.map(toTimelineEntry),
      actions: actions.rows.map((row) => row.action),
      limit,
      offset,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/events/:id/duplicate  - copy a past event into a new draft
// ---------------------------------------------------------------------------

interface SourceRow {
  id: string;
  organizer_id: string;
  organizer_name: string;
  title: string;
  description: string;
  venue_name: string;
  venue_address: string;
  cover_image_url: string | null;
  refund_policy: string | null;
  starts_at: Date;
  ends_at: Date;
  // Whole weeks to move the event forward so its start is in the future. 0 already is.
  weeks_forward: number;
}

interface DuplicatedTicketTypeRow {
  id: string;
  name: string;
  price: number;
  currency: string;
  quantity_total: number;
  sales_start_at: Date | null;
  sales_end_at: Date | null;
  is_hidden: boolean;
}

// docs/api.md "event" object, the manage shape: the new draft has no paid-sales
// activation and no orders, so every ticket type's available count is its total.
function toDuplicatedEvent(
  event: SourceRow,
  startsAt: Date,
  endsAt: Date,
  ticketTypes: DuplicatedTicketTypeRow[],
) {
  return {
    id: event.id,
    title: event.title,
    description: event.description,
    venue_name: event.venue_name,
    venue_address: event.venue_address,
    starts_at: startsAt,
    ends_at: endsAt,
    status: 'draft',
    cover_image_url: event.cover_image_url,
    refund_policy: event.refund_policy,
    organizer: { id: event.organizer_id, name: event.organizer_name },
    paid_sales_active: false,
    ticket_types: ticketTypes
      .map((type) => ({
        id: type.id,
        name: type.name,
        price: type.price,
        currency: type.currency,
        quantity_total: type.quantity_total,
        quantity_available: type.quantity_total,
        sales_start_at: type.sales_start_at,
        sales_end_at: type.sales_end_at,
        is_hidden: type.is_hidden,
      }))
      .sort((a, b) => a.price - b.price || a.name.localeCompare(b.name)),
  };
}

eventHistoryRouter.post('/events/:id/duplicate', requireAuth, async (req, res, next) => {
  try {
    const params = eventIdParamSchema.safeParse(req.params);
    if (!params.success) {
      throw AppError.badRequest('Event id must be a UUID');
    }
    const eventId = params.data.id;

    const result = await withTransaction(async (client) => {
      // Lock the source so two duplicates at once do not read different ticket types.
      const sourceResult = await client.query<SourceRow>(
        `SELECT e.id,
                e.organizer_id,
                u.name AS organizer_name,
                e.title,
                e.description,
                e.venue_name,
                e.venue_address,
                e.cover_image_url,
                e.refund_policy,
                e.starts_at,
                e.ends_at,
                GREATEST(
                  0,
                  floor(extract(epoch from (now() - e.starts_at)) / 604800)::int + 1
                ) AS weeks_forward
           FROM events e
           JOIN users u ON u.id = e.organizer_id
          WHERE e.id = $1
          FOR UPDATE OF e`,
        [eventId],
      );
      const source = sourceResult.rows[0];
      if (!source || source.organizer_id !== req.user!.id) {
        throw AppError.notFound(ErrorCode.EVENT_NOT_FOUND, 'Event not found');
      }

      // Whole weeks keep the weekday and the local time of day. A start already in the
      // future is kept as it is (weeks_forward is 0).
      const shiftMs = source.weeks_forward * 7 * 24 * 60 * 60 * 1000;
      const startsAt = new Date(source.starts_at.getTime() + shiftMs);
      const endsAt = new Date(source.ends_at.getTime() + shiftMs);

      // Only reusable configuration is copied. Suspension, paid-sales activation,
      // orders, tickets, payments, refunds, check-ins, promo campaigns and staff are
      // deliberately absent: the new draft starts clean.
      const eventResult = await client.query<SourceRow>(
        `INSERT INTO events (organizer_id, title, description, venue_name, venue_address,
                             starts_at, ends_at, status, cover_image_url, refund_policy)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft', $8, $9)
         RETURNING id, organizer_id, $10::text AS organizer_name, title, description,
                   venue_name, venue_address, cover_image_url, refund_policy,
                   starts_at, ends_at, 0 AS weeks_forward`,
        [
          source.organizer_id,
          source.title,
          source.description,
          source.venue_name,
          source.venue_address,
          startsAt,
          endsAt,
          source.cover_image_url,
          source.refund_policy,
          source.organizer_name,
        ],
      );
      const created = eventResult.rows[0];
      if (!created) {
        throw new AppError(ErrorCode.INTERNAL_ERROR, 'Failed to duplicate event', 500);
      }

      // Ticket type sales windows move with the event, otherwise a copied past event
      // would be born with sales already closed.
      const ticketTypes = await client.query<DuplicatedTicketTypeRow>(
        `INSERT INTO ticket_types (event_id, name, price, currency, quantity_total,
                                   sales_start_at, sales_end_at, is_hidden)
         SELECT $1, name, price, currency, quantity_total,
                sales_start_at + ($2::int * interval '7 days'),
                sales_end_at + ($2::int * interval '7 days'),
                is_hidden
           FROM ticket_types
          WHERE event_id = $3
         RETURNING id, name, price, currency, quantity_total, sales_start_at,
                   sales_end_at, is_hidden`,
        [created.id, source.weeks_forward, source.id],
      );

      await recordAudit(client, {
        actorId: req.user!.id,
        action: 'event.created',
        entityType: 'event',
        entityId: created.id,
        eventId: created.id,
        description: `Created the event "${created.title}"`,
      });
      await recordAudit(client, {
        actorId: req.user!.id,
        action: 'event.duplicated',
        entityType: 'event',
        entityId: created.id,
        eventId: created.id,
        description: `Duplicated from event ${source.id}`,
      });

      return toDuplicatedEvent(created, startsAt, endsAt, ticketTypes.rows);
    });

    res.status(201).json({ event: result });
  } catch (err) {
    next(err);
  }
});
