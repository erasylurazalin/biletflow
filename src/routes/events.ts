/**
 * Public event endpoints. THIS FILE IS THE PATTERN. Copy its shape.
 *
 * Layering, top to bottom, for every endpoint in this project:
 *
 *   1. Zod schema      Describe what the request is allowed to contain. Parse it
 *                      first, before touching the database. After parse() you have a
 *                      typed value and nothing else in the handler has to wonder
 *                      whether `limit` is a string, a number or "abc".
 *   2. SQL             Written here, in the route file, with $1/$2 parameters. There
 *                      is no repository layer and no service layer. At our size they
 *                      would be files you have to open to find one query. Never build
 *                      SQL by string concatenation with user input: use parameters, or
 *                      you have handed the internet a shell into our database.
 *   3. Mapping         Turn database rows into exactly the JSON in docs/api.md. Do not
 *                      send `rows` straight out: the table has columns the API does
 *                      not promise (and one day will have columns it must not leak).
 *   4. Errors          Throw AppError. Never res.status(404).json(...) by hand, or the
 *                      error shape drifts endpoint by endpoint. src/middleware/
 *                      error-handler.ts formats everything.
 *
 * Everything the route returns must match docs/api.md. If you need a different shape,
 * change the doc first and tell the group chat.
 */
import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool';
import { withTransaction } from '../db/transaction';
import { recordAudit } from '../lib/audit';
import { AppError, ErrorCode } from '../lib/errors';
import { requireAuth } from '../middleware/auth';

export const eventsRouter = Router();

// ---------------------------------------------------------------------------
// GET /api/events  - public list of published events
// ---------------------------------------------------------------------------

// Query strings are always strings, so coerce and then validate. Defaults live here,
// which means the handler below can assume it always has real numbers.
const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  // Optional free-text search on the title.
  q: z.string().trim().min(1).max(100).optional(),
});

// Shape of one row coming back from the list query. Naming the type keeps the mapping
// below honest: rename a column in the SQL and TypeScript points at the mapping.
interface EventListRow {
  id: string;
  title: string;
  short_description: string;
  venue_name: string;
  venue_address: string;
  starts_at: Date;
  ends_at: Date;
  status: string;
  cover_image_url: string | null;
  organizer_id: string;
  organizer_name: string;
}

eventsRouter.get('/', async (req, res, next) => {
  try {
    // safeParse instead of parse: we want our own 400 with a readable message rather
    // than a ZodError bubbling up as an unexpected 500.
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw AppError.badRequest(
        first
          ? `Invalid query parameter "${first.path.join('.')}": ${first.message}`
          : 'Invalid query',
      );
    }
    const { limit, offset, q } = parsed.data;

    const result = await pool.query<EventListRow>(
      `SELECT e.id,
              e.title,
              -- docs/api.md: list items carry a shortened description, detail carries
              -- the full one. Trimming here keeps the list response small.
              left(e.description, 200) AS short_description,
              e.venue_name,
              e.venue_address,
              e.starts_at,
              e.ends_at,
              e.status,
              e.cover_image_url,
              u.id   AS organizer_id,
              u.name AS organizer_name
         FROM events e
         JOIN users u ON u.id = e.organizer_id
        -- Public endpoint: drafts and cancelled events are nobody else's business.
        WHERE e.status = 'published'
          -- $3 is NULL when no search was given, and then this condition is TRUE for
          -- every row. One query instead of two, without concatenating SQL.
          AND ($3::text IS NULL OR e.title ILIKE '%' || $3 || '%')
        ORDER BY e.starts_at ASC
        LIMIT $1 OFFSET $2`,
      [limit, offset, q ?? null],
    );

    // Timestamps are Date objects from pg; res.json() serialises them as ISO 8601 UTC,
    // which is what docs/api.md asks for.
    res.json({
      events: result.rows.map((row) => ({
        id: row.id,
        title: row.title,
        description: row.short_description,
        venue_name: row.venue_name,
        venue_address: row.venue_address,
        starts_at: row.starts_at,
        ends_at: row.ends_at,
        status: row.status,
        cover_image_url: row.cover_image_url,
        organizer: { id: row.organizer_id, name: row.organizer_name },
      })),
      // The doc does not describe a list envelope, so this is our pick: echo back the
      // paging the client asked for. Announced in the group chat before it was written.
      limit,
      offset,
    });
  } catch (err) {
    // Errors thrown inside an async function do not reach Express by themselves in
    // every version, so hand them over explicitly. Same three lines in every handler.
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/events/:id  - public detail, including ticket types
// ---------------------------------------------------------------------------

const idParamSchema = z.object({ id: z.uuid() });

interface EventDetailRow extends Omit<EventListRow, 'short_description'> {
  description: string;
  paid_sales_active: boolean;
  refund_policy: string | null;
}

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

eventsRouter.get('/:id', async (req, res, next) => {
  try {
    const parsed = idParamSchema.safeParse(req.params);
    if (!parsed.success) {
      throw AppError.badRequest('Event id must be a UUID');
    }
    const { id } = parsed.data;

    const eventResult = await pool.query<EventDetailRow>(
      `SELECT e.id,
              e.title,
              e.description,
              e.venue_name,
              e.venue_address,
              e.starts_at,
              e.ends_at,
              e.status,
              e.cover_image_url,
              e.refund_policy,
              u.id   AS organizer_id,
              u.name AS organizer_name,
              -- Whether paid ticket types can be bought yet (migration 004).
              EXISTS (SELECT 1
                        FROM paid_sales_activations psa
                       WHERE psa.event_id = e.id
                         AND psa.activated_at IS NOT NULL) AS paid_sales_active
         FROM events e
         JOIN users u ON u.id = e.organizer_id
        WHERE e.id = $1
          AND e.status = 'published'`,
      [id],
    );

    const event = eventResult.rows[0];
    if (!event) {
      // Unpublished events answer 404 as well, on purpose: "this id exists but you may
      // not see it" tells a stranger more than they need to know.
      throw AppError.notFound(ErrorCode.EVENT_NOT_FOUND, 'Event not found');
    }

    const ticketTypesResult = await pool.query<TicketTypeRow>(
      `SELECT tt.id,
              tt.name,
              tt.price,
              tt.currency,
              tt.quantity_total,
              -- quantity_available is computed, never stored (docs/api.md). A stored
              -- counter would drift the first time an order failed halfway through.
              tt.quantity_total - COALESCE(held.quantity, 0) AS quantity_available,
              tt.sales_start_at,
              tt.sales_end_at,
              tt.is_hidden
         FROM ticket_types tt
         LEFT JOIN (
              -- Seats held by orders: paid ones for good, pending ones until they
              -- expire. The orders endpoints are somebody else's task; this only reads
              -- what they write.
              SELECT oi.ticket_type_id, SUM(oi.quantity)::int AS quantity
                FROM order_items oi
                JOIN orders o ON o.id = oi.order_id
               WHERE o.status = 'paid'
                  OR (o.status = 'pending' AND (o.expires_at IS NULL OR o.expires_at > now()))
               GROUP BY oi.ticket_type_id
         ) held ON held.ticket_type_id = tt.id
        WHERE tt.event_id = $1
          AND tt.is_hidden = false
        ORDER BY tt.price ASC, tt.name ASC`,
      [id],
    );

    res.json({
      event: {
        id: event.id,
        title: event.title,
        description: event.description,
        venue_name: event.venue_name,
        venue_address: event.venue_address,
        starts_at: event.starts_at,
        ends_at: event.ends_at,
        status: event.status,
        cover_image_url: event.cover_image_url,
        refund_policy: event.refund_policy,
        organizer: { id: event.organizer_id, name: event.organizer_name },
        paid_sales_active: event.paid_sales_active,
        ticket_types: ticketTypesResult.rows,
      },
    });
  } catch (err) {
    next(err);
  }
});
// ---------------------------------------------------------------------------
// POST /api/events  - organizer creates a new draft event
// ---------------------------------------------------------------------------

const createEventSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1),
    venue_name: z.string().trim().min(1).max(200),
    venue_address: z.string().trim().min(1).max(300),
    starts_at: z.coerce.date(),
    ends_at: z.coerce.date(),
    cover_image_url: z.url().nullable().optional(),
    // Free text shown to attendees on the event page. Information only: nothing
    // enforces it (docs/decisions.md, decision 10).
    refund_policy: z.string().trim().min(1).max(2000).nullable().optional(),
  })
  .refine((data) => data.ends_at > data.starts_at, {
    message: 'ends_at must be after starts_at',
    path: ['ends_at'],
  });

eventsRouter.post('/', requireAuth, async (req, res, next) => {
  try {
    // Only organizers create events. Same AppError shape as every other 403 here.
    if (req.user!.role !== 'organizer') {
      throw AppError.forbidden('Only organizers can create events');
    }

    const parsed = createEventSchema.safeParse(req.body);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw AppError.badRequest(
        first ? `Invalid field "${first.path.join('.')}": ${first.message}` : 'Invalid event data',
      );
    }
    const {
      title,
      description,
      venue_name,
      venue_address,
      starts_at,
      ends_at,
      cover_image_url,
      refund_policy,
    } = parsed.data;

    // New events always start as drafts. Status is not something the client gets to
    // set on creation. Publishing is a separate endpoint (POST /:id/publish).
    const result = await pool.query<EventDetailRow>(
      `WITH inserted AS (
         INSERT INTO events (title, description, venue_name, venue_address, starts_at,
                              ends_at, cover_image_url, refund_policy, organizer_id, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'draft')
         RETURNING id, title, description, venue_name, venue_address, starts_at, ends_at,
                   status, cover_image_url, refund_policy, organizer_id
       )
       SELECT inserted.*, u.name AS organizer_name
         FROM inserted
         JOIN users u ON u.id = inserted.organizer_id`,
      [
        title,
        description,
        venue_name,
        venue_address,
        starts_at,
        ends_at,
        cover_image_url ?? null,
        refund_policy ?? null,
        req.user!.id,
      ],
    );
    const event = result.rows[0];
    if (!event) {
      throw new AppError(ErrorCode.INTERNAL_ERROR, 'Failed to create event', 500);
    }

    res.status(201).json({
      event: {
        id: event.id,
        title: event.title,
        description: event.description,
        venue_name: event.venue_name,
        venue_address: event.venue_address,
        starts_at: event.starts_at,
        ends_at: event.ends_at,
        status: event.status,
        cover_image_url: event.cover_image_url,
        refund_policy: event.refund_policy,
        organizer: { id: event.organizer_id, name: event.organizer_name },
      },
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/events/:id  - organizer edits their own event
// ---------------------------------------------------------------------------

const updateEventSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1),
    venue_name: z.string().trim().min(1).max(200),
    venue_address: z.string().trim().min(1).max(300),
    starts_at: z.coerce.date(),
    ends_at: z.coerce.date(),
    cover_image_url: z.url().nullable(),
    // null clears the policy (docs/api.md "Events").
    refund_policy: z.string().trim().min(1).max(2000).nullable(),
    // status is deliberately not editable here: publishing is its own endpoint
    // (POST /:id/publish, someone else's task) and PATCH should not race it.
  })
  .partial()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided',
  });

eventsRouter.patch('/:id', requireAuth, async (req, res, next) => {
  try {
    const idParsed = idParamSchema.safeParse(req.params);
    if (!idParsed.success) {
      throw AppError.badRequest('Event id must be a UUID');
    }
    const { id } = idParsed.data;

    const bodyParsed = updateEventSchema.safeParse(req.body);
    if (!bodyParsed.success) {
      const first = bodyParsed.error.issues[0];
      throw AppError.badRequest(
        first ? `Invalid field "${first.path.join('.')}": ${first.message}` : 'Invalid event data',
      );
    }

    // Ownership is checked against the database, not the JWT: role alone doesn't say
    // whose event this is. This also gets us organizer_name for the response for free.
    const ownerResult = await pool.query<{
      organizer_id: string;
      organizer_name: string;
      starts_at: Date;
      ends_at: Date;
    }>(
      `SELECT e.organizer_id, u.name AS organizer_name, e.starts_at, e.ends_at
         FROM events e
         JOIN users u ON u.id = e.organizer_id
        WHERE e.id = $1`,
      [id],
    );
    const owner = ownerResult.rows[0];
    if (!owner) {
      throw AppError.notFound(ErrorCode.EVENT_NOT_FOUND, 'Event not found');
    }
    if (owner.organizer_id !== req.user!.id) {
      throw AppError.forbidden('You can only edit your own events');
    }
    const mergedStartsAt = bodyParsed.data.starts_at ?? owner.starts_at;
    const mergedEndsAt = bodyParsed.data.ends_at ?? owner.ends_at;
    if (mergedEndsAt <= mergedStartsAt) {
      throw AppError.badRequest('Invalid field "ends_at": ends_at must be after starts_at');
    }
    // Keys come from the parsed Zod object, never straight from req.body, so this is
    // building SQL from a fixed, known field set, not from arbitrary user input.
    const fields = Object.entries(bodyParsed.data).filter(([, value]) => value !== undefined);
    const setClause = fields.map(([key], i) => `${key} = $${i + 1}`).join(', ');
    const values = fields.map(([, value]) => value);

    // No updated_at here on purpose: the events_set_updated_at trigger (001_init.sql)
    // stamps it automatically on every UPDATE.
    const updateResult = await pool.query<EventDetailRow>(
      `UPDATE events
          SET ${setClause}
        WHERE id = $${fields.length + 1}
        RETURNING id, title, description, venue_name, venue_address, starts_at, ends_at,
                  status, cover_image_url, refund_policy, organizer_id`,
      [...values, id],
    );
    const event = updateResult.rows[0];
    if (!event) {
      throw new AppError(ErrorCode.INTERNAL_ERROR, 'Failed to update event', 500);
    }
    res.json({
      event: {
        id: event.id,
        title: event.title,
        description: event.description,
        venue_name: event.venue_name,
        venue_address: event.venue_address,
        starts_at: event.starts_at,
        ends_at: event.ends_at,
        status: event.status,
        cover_image_url: event.cover_image_url,
        refund_policy: event.refund_policy,
        organizer: { id: event.organizer_id, name: owner.organizer_name },
      },
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/events/:id/publish  - organizer publishes their own draft
// ---------------------------------------------------------------------------

interface EventMutationRow extends EventDetailRow {
  organizer_name: string;
  start_time_passed: boolean;
}

function toOwnedEvent(event: EventDetailRow, organizerName: string) {
  return {
    id: event.id,
    title: event.title,
    description: event.description,
    venue_name: event.venue_name,
    venue_address: event.venue_address,
    starts_at: event.starts_at,
    ends_at: event.ends_at,
    status: event.status,
    cover_image_url: event.cover_image_url,
    refund_policy: event.refund_policy,
    organizer: { id: event.organizer_id, name: organizerName },
  };
}

const EVENT_FOR_UPDATE = `SELECT e.id, e.title, e.description, e.venue_name, e.venue_address,
         e.starts_at, e.ends_at, e.status, e.cover_image_url, e.refund_policy,
         e.organizer_id,
         u.name AS organizer_name, e.starts_at <= now() AS start_time_passed
    FROM events e
    JOIN users u ON u.id = e.organizer_id
   WHERE e.id = $1
   FOR UPDATE OF e`;

eventsRouter.post('/:id/publish', requireAuth, async (req, res, next) => {
  try {
    const idParsed = idParamSchema.safeParse(req.params);
    if (!idParsed.success) {
      throw AppError.badRequest('Event id must be a UUID');
    }
    const { id } = idParsed.data;

    const event = await withTransaction(async (client) => {
      const ownerResult = await client.query<EventMutationRow>(EVENT_FOR_UPDATE, [id]);
      const owner = ownerResult.rows[0];
      if (!owner) {
        throw AppError.notFound(ErrorCode.EVENT_NOT_FOUND, 'Event not found');
      }
      if (owner.organizer_id !== req.user!.id) {
        throw AppError.forbidden('You can only publish your own events');
      }
      if (owner.status === 'published') {
        throw AppError.conflict(ErrorCode.CONFLICT, 'The event is already published');
      }
      if (owner.status === 'cancelled') {
        throw AppError.conflict(ErrorCode.CONFLICT, 'A cancelled event cannot be published');
      }

      const ticketTypes = await client.query<{ has_ticket_types: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM ticket_types WHERE event_id = $1) AS has_ticket_types`,
        [id],
      );
      if (!ticketTypes.rows[0]?.has_ticket_types) {
        throw AppError.conflict(
          ErrorCode.CONFLICT,
          'Add at least one ticket type before publishing',
        );
      }
      if (owner.start_time_passed) {
        throw AppError.conflict(ErrorCode.CONFLICT, 'The event start time has already passed');
      }

      const updateResult = await client.query<EventDetailRow>(
        `UPDATE events SET status = 'published'
          WHERE id = $1
          RETURNING id, title, description, venue_name, venue_address, starts_at, ends_at,
                    status, cover_image_url, refund_policy, organizer_id`,
        [id],
      );
      const updated = updateResult.rows[0];
      if (!updated) {
        throw new AppError(ErrorCode.INTERNAL_ERROR, 'Failed to publish event', 500);
      }
      await recordAudit(client, {
        actorId: req.user!.id,
        action: 'event.published',
        entityType: 'event',
        entityId: id,
        eventId: id,
        description: 'Published the event',
      });
      return { event: updated, organizerName: owner.organizer_name };
    });

    res.json({ event: toOwnedEvent(event.event, event.organizerName) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/events/:id/cancel  - organizer cancels their own event
// ---------------------------------------------------------------------------

eventsRouter.post('/:id/cancel', requireAuth, async (req, res, next) => {
  try {
    const idParsed = idParamSchema.safeParse(req.params);
    if (!idParsed.success) {
      throw AppError.badRequest('Event id must be a UUID');
    }
    const { id } = idParsed.data;

    const event = await withTransaction(async (client) => {
      const ownerResult = await client.query<EventMutationRow>(EVENT_FOR_UPDATE, [id]);
      const owner = ownerResult.rows[0];
      if (!owner) {
        throw AppError.notFound(ErrorCode.EVENT_NOT_FOUND, 'Event not found');
      }
      if (owner.organizer_id !== req.user!.id) {
        throw AppError.forbidden('You can only cancel your own events');
      }
      if (owner.status === 'cancelled') {
        throw AppError.conflict(ErrorCode.CONFLICT, 'The event is already cancelled');
      }

      const updateResult = await client.query<EventDetailRow>(
        `UPDATE events SET status = 'cancelled'
          WHERE id = $1
          RETURNING id, title, description, venue_name, venue_address, starts_at, ends_at,
                    status, cover_image_url, refund_policy, organizer_id`,
        [id],
      );
      const updated = updateResult.rows[0];
      if (!updated) {
        throw new AppError(ErrorCode.INTERNAL_ERROR, 'Failed to cancel event', 500);
      }
      const tickets = await client.query(
        `UPDATE tickets SET status = 'cancelled'
          WHERE event_id = $1 AND status = 'valid'`,
        [id],
      );
      const orders = await client.query(
        `UPDATE orders SET status = 'cancelled'
          WHERE event_id = $1 AND status = 'pending'`,
        [id],
      );
      const ticketCount = tickets.rowCount ?? 0;
      const orderCount = orders.rowCount ?? 0;
      await recordAudit(client, {
        actorId: req.user!.id,
        action: 'event.cancelled',
        entityType: 'event',
        entityId: id,
        eventId: id,
        description: `Cancelled the event: ${ticketCount} tickets and ${orderCount} pending orders cancelled`,
      });
      return { event: updated, organizerName: owner.organizer_name };
    });

    res.json({ event: toOwnedEvent(event.event, event.organizerName) });
  } catch (err) {
    next(err);
  }
});
