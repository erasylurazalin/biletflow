/**
 * Check-in staff: organizers put people on the door of their events, and the mobile app
 * asks which events the logged-in user is on the door of. Same layering as
 * routes/events.ts.
 *
 * Being assigned is what makes somebody an event's admin, not users.role (docs/api.md,
 * migration 002). Anyone with an account can be assigned, the organizer included, and
 * assigning somebody does not change their role.
 *
 * The /events/:id/staff endpoints belong to the event's organizer: a missing event is
 * 404, somebody else's event is 403.
 */
import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool';
import { AppError, ErrorCode } from '../lib/errors';
import { requireAuth } from '../middleware/auth';

// Mounted at /api, because the paths start in two places (/events/:id/staff and
// /staff/events). requireAuth goes on each route, never on router.use(): this router
// sees every /api request, and the public ones must not demand a token.
export const staffRouter = Router();

const eventIdParamSchema = z.object({ id: z.uuid() });

// Same paging as GET /api/events (docs/api.md "List responses").
const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

function badRequestFrom(error: z.ZodError, what: string): AppError {
  const first = error.issues[0];
  return AppError.badRequest(
    first ? `Invalid ${what} "${first.path.join('.')}": ${first.message}` : `Invalid ${what}`,
  );
}

function parseListQuery(query: unknown) {
  const parsed = listQuerySchema.safeParse(query);
  if (!parsed.success) {
    throw badRequestFrom(parsed.error, 'query parameter');
  }
  return parsed.data;
}

interface StaffRow {
  id: string;
  email: string;
  name: string;
  assigned_at: Date;
}

// docs/api.md "staff_member" object. `id` is the user's id, which is what
// DELETE /api/events/:id/staff/:userId takes.
function toStaffMember(row: StaffRow) {
  return { id: row.id, email: row.email, name: row.name, assigned_at: row.assigned_at };
}

// 404 if the event does not exist, 403 if it is not mine.
async function assertOwnsEvent(eventId: string, userId: string): Promise<void> {
  const result = await pool.query<{ organizer_id: string }>(
    `SELECT organizer_id FROM events WHERE id = $1`,
    [eventId],
  );
  const event = result.rows[0];
  if (!event) {
    throw AppError.notFound(ErrorCode.EVENT_NOT_FOUND, 'Event not found');
  }
  if (event.organizer_id !== userId) {
    throw AppError.forbidden("Only the event's organizer can manage its staff");
  }
}

// ---------------------------------------------------------------------------
// POST /api/events/:id/staff  - put a registered user on the door of my event
// ---------------------------------------------------------------------------

// Emails are stored and compared lower-cased (see users_email_lower_idx).
const assignSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
});

staffRouter.post('/events/:id/staff', requireAuth, async (req, res, next) => {
  try {
    const params = eventIdParamSchema.safeParse(req.params);
    if (!params.success) {
      throw AppError.badRequest('Event id must be a UUID');
    }
    const body = assignSchema.safeParse(req.body);
    if (!body.success) {
      throw badRequestFrom(body.error, 'field');
    }
    const eventId = params.data.id;

    // requireAuth guarantees req.user.
    await assertOwnsEvent(eventId, req.user!.id);

    const userResult = await pool.query<{ id: string; email: string; name: string }>(
      `SELECT id, email, name FROM users WHERE lower(email) = $1`,
      [body.data.email],
    );
    const user = userResult.rows[0];
    if (!user) {
      throw AppError.notFound(ErrorCode.USER_NOT_FOUND, 'No account with this email');
    }

    // Assigning somebody twice is not an error: the unique (event_id, user_id)
    // constraint turns the second INSERT into a no-op, and no row back means they were
    // already on the staff.
    const inserted = await pool.query<{ assigned_at: Date }>(
      `INSERT INTO event_staff (event_id, user_id, assigned_by)
       VALUES ($1, $2, $3)
       ON CONFLICT ON CONSTRAINT event_staff_event_user_unique DO NOTHING
       RETURNING created_at AS assigned_at`,
      [eventId, user.id, req.user!.id],
    );
    let row = inserted.rows[0];
    const created = row !== undefined;
    if (!row) {
      const existing = await pool.query<{ assigned_at: Date }>(
        `SELECT created_at AS assigned_at
           FROM event_staff
          WHERE event_id = $1 AND user_id = $2`,
        [eventId, user.id],
      );
      row = existing.rows[0];
    }
    if (!row) {
      // The conflicting row was removed between the two queries.
      throw AppError.conflict(ErrorCode.CONFLICT, 'The staff list changed meanwhile. Try again.');
    }

    res.status(created ? 201 : 200).json({
      staff_member: toStaffMember({ ...user, assigned_at: row.assigned_at }),
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/events/:id/staff  - who is on the door of my event
// ---------------------------------------------------------------------------

staffRouter.get('/events/:id/staff', requireAuth, async (req, res, next) => {
  try {
    const params = eventIdParamSchema.safeParse(req.params);
    if (!params.success) {
      throw AppError.badRequest('Event id must be a UUID');
    }
    const { limit, offset } = parseListQuery(req.query);

    await assertOwnsEvent(params.data.id, req.user!.id);

    const result = await pool.query<StaffRow>(
      `SELECT u.id, u.email, u.name, s.created_at AS assigned_at
         FROM event_staff s
         JOIN users u ON u.id = s.user_id
        WHERE s.event_id = $1
        ORDER BY s.created_at ASC, u.id ASC
        LIMIT $2 OFFSET $3`,
      [params.data.id, limit, offset],
    );

    res.json({ staff: result.rows.map(toStaffMember), limit, offset });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/events/:id/staff/:userId  - take somebody off the door of my event
// ---------------------------------------------------------------------------

const removeParamSchema = z.object({ id: z.uuid(), userId: z.uuid() });

staffRouter.delete('/events/:id/staff/:userId', requireAuth, async (req, res, next) => {
  try {
    const params = removeParamSchema.safeParse(req.params);
    if (!params.success) {
      throw AppError.badRequest('Event id and user id must be UUIDs');
    }

    await assertOwnsEvent(params.data.id, req.user!.id);

    const result = await pool.query(
      `DELETE FROM event_staff WHERE event_id = $1 AND user_id = $2`,
      [params.data.id, params.data.userId],
    );
    if (result.rowCount === 0) {
      throw AppError.notFound(ErrorCode.NOT_FOUND, 'This user is not on the staff of this event');
    }

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/staff/events  - the events I am on the door of (mobile "my events")
// ---------------------------------------------------------------------------

interface StaffEventRow {
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

staffRouter.get('/staff/events', requireAuth, async (req, res, next) => {
  try {
    const { limit, offset } = parseListQuery(req.query);

    // Every status is listed, not only published: staff may be put on the door before
    // the event is published, and a cancelled event should show up as cancelled rather
    // than vanish from the app. `status` is in the response for the app to decide.
    const result = await pool.query<StaffEventRow>(
      `SELECT e.id,
              e.title,
              left(e.description, 200) AS short_description,
              e.venue_name,
              e.venue_address,
              e.starts_at,
              e.ends_at,
              e.status,
              e.cover_image_url,
              u.id   AS organizer_id,
              u.name AS organizer_name
         FROM event_staff s
         JOIN events e ON e.id = s.event_id
         JOIN users u ON u.id = e.organizer_id
        WHERE s.user_id = $1
        ORDER BY e.starts_at ASC, e.id ASC
        LIMIT $2 OFFSET $3`,
      [req.user!.id, limit, offset],
    );

    // Same list item shape as GET /api/events.
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
      limit,
      offset,
    });
  } catch (err) {
    next(err);
  }
});
