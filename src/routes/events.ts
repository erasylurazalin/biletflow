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
import { AppError, ErrorCode } from '../lib/errors';

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
              u.id   AS organizer_id,
              u.name AS organizer_name
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
        organizer: { id: event.organizer_id, name: event.organizer_name },
        ticket_types: ticketTypesResult.rows,
      },
    });
  } catch (err) {
    next(err);
  }
});
