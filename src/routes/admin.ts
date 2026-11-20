/**
 * Platform administration (SRS 4.12). For now only suspending an event; the rest of the
 * admin work (search, users, reports, the admin pages) is #63. Same layering as
 * routes/events.ts.
 *
 * A suspended event leaves the public list and detail and takes no new orders, and
 * lifting the suspension restores it (migration 010). Existing orders and tickets are
 * not touched either way.
 *
 * Every endpoint here is for `platform_admin` only: anybody else logged in gets 403.
 */
import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { withTransaction } from '../db/transaction';
import { recordAudit } from '../lib/audit';
import { AppError, ErrorCode } from '../lib/errors';
import { requireAuth } from '../middleware/auth';

// Mounted at /api, because the paths start with /admin. requireAuth goes on each route,
// never on router.use(): this router sees every /api request, and the public ones must
// not demand a token.
export const adminRouter = Router();

const idParamSchema = z.object({ id: z.uuid() });

interface SuspensionRow {
  id: string;
  title: string;
  status: string;
  suspended_at: Date | null;
}

// Runs after requireAuth, so req.user is there.
function requirePlatformAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (req.user?.role !== 'platform_admin') {
    throw AppError.forbidden('Only platform administrators can do that');
  }
  next();
}

function parseEventId(params: unknown): string {
  const parsed = idParamSchema.safeParse(params);
  if (!parsed.success) {
    throw AppError.badRequest('Event id must be a UUID');
  }
  return parsed.data.id;
}

// docs/api.md "Admin: suspending an event". `status` is the organizer's status and does
// not change; `suspended` is the platform's flag on top of it.
function toSuspension(row: SuspensionRow) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    suspended: row.suspended_at !== null,
    suspended_at: row.suspended_at,
  };
}

async function setSuspended(req: Request, suspend: boolean) {
  const eventId = parseEventId(req.params);
  const adminId = req.user!.id;

  return withTransaction(async (client) => {
    // The row lock makes two admins suspending the same event at once take turns, so the
    // second sees the first one's result and gets the 409 instead of a second audit entry.
    const found = await client.query<SuspensionRow>(
      `SELECT id, title, status, suspended_at
         FROM events
        WHERE id = $1
          FOR UPDATE`,
      [eventId],
    );
    const current = found.rows[0];
    if (!current) {
      throw AppError.notFound(ErrorCode.EVENT_NOT_FOUND, 'Event not found');
    }
    if (suspend && current.suspended_at !== null) {
      throw AppError.conflict(ErrorCode.CONFLICT, 'The event is already suspended');
    }
    if (!suspend && current.suspended_at === null) {
      throw AppError.conflict(ErrorCode.CONFLICT, 'The event is not suspended');
    }

    const updated = suspend
      ? await client.query<SuspensionRow>(
          `UPDATE events
              SET suspended_at = now(), suspended_by = $2, updated_at = now()
            WHERE id = $1
        RETURNING id, title, status, suspended_at`,
          [eventId, adminId],
        )
      : await client.query<SuspensionRow>(
          `UPDATE events
              SET suspended_at = NULL, suspended_by = NULL, updated_at = now()
            WHERE id = $1
        RETURNING id, title, status, suspended_at`,
          [eventId],
        );

    await recordAudit(client, {
      actorId: adminId,
      action: suspend ? 'event.suspended' : 'event.unsuspended',
      entityType: 'event',
      entityId: eventId,
      eventId,
      description: suspend ? 'Suspended the event' : 'Lifted the suspension of the event',
    });

    return updated.rows[0]!;
  });
}

// POST /api/admin/events/:id/suspend
adminRouter.post(
  '/admin/events/:id/suspend',
  requireAuth,
  requirePlatformAdmin,
  async (req, res) => {
    res.json({ event: toSuspension(await setSuspended(req, true)) });
  },
);

// POST /api/admin/events/:id/unsuspend
adminRouter.post(
  '/admin/events/:id/unsuspend',
  requireAuth,
  requirePlatformAdmin,
  async (req, res) => {
    res.json({ event: toSuspension(await setSuspended(req, false)) });
  },
);
