/**
 * Platform administration (SRS 2.1, 4.5, 4.12). Same layering as routes/events.ts.
 *
 * This file covers:
 *   - suspending an event (migration 010, the first admin feature);
 *   - finding and suspending users (migration 012);
 *   - searching every event in every status, with its open report count;
 *   - reporting a published event, and reviewing reports;
 *   - reading and changing the platform-wide activation fee;
 *   - searching orders and exporting orders and refunds as CSV.
 *
 * A suspended event leaves the public list and detail and takes no new orders, and
 * lifting the suspension restores it. Existing orders and tickets are not touched either
 * way. A suspended user cannot log in; an already-issued JWT keeps working until it
 * expires, because requireAuth deliberately does not read the database
 * (docs/decisions.md, decision 15).
 *
 * Every /api/admin/* endpoint here is for `platform_admin` only: anybody else logged in
 * gets 403. Reporting an event is the one endpoint in this file for any logged-in user.
 */
import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { pool } from '../db/pool';
import { withTransaction } from '../db/transaction';
import { recordAudit } from '../lib/audit';
import { AppError, ErrorCode } from '../lib/errors';
import { PAYMENT_COLUMNS, toPayment, type PaymentColumns } from '../lib/payments';
import { REFUND_COLUMNS, toRefund, type RefundColumns } from '../lib/refunds';
import { requireAuth } from '../middleware/auth';

// Mounted at /api, because the paths start with /admin. requireAuth goes on each route,
// never on router.use(): this router sees every /api request, and the public ones must
// not demand a token.
export const adminRouter = Router();

const idParamSchema = z.object({ id: z.uuid() });

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  q: z.string().trim().min(1).max(100).optional(),
});

function badRequestFrom(error: z.ZodError, what: string): AppError {
  const first = error.issues[0];
  return AppError.badRequest(
    first ? `Invalid ${what} "${first.path.join('.')}": ${first.message}` : `Invalid ${what}`,
  );
}

// Runs after requireAuth, so req.user is there.
function requirePlatformAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (req.user?.role !== 'platform_admin') {
    throw AppError.forbidden('Only platform administrators can do that');
  }
  next();
}

function parseId(params: unknown, what: string): string {
  const parsed = idParamSchema.safeParse(params);
  if (!parsed.success) {
    throw AppError.badRequest(`${what} id must be a UUID`);
  }
  return parsed.data.id;
}

// A LIKE pattern with the user's %, _ and \ escaped, so a search for "100%" means the
// literal text and not "anything after 100".
function likePattern(q: string | undefined): string | null {
  if (!q) return null;
  return `%${q.replace(/[\\%_]/g, '\\$&')}%`;
}

// ---------------------------------------------------------------------------
// Event suspension
// ---------------------------------------------------------------------------

interface SuspensionRow {
  id: string;
  title: string;
  status: string;
  suspended_at: Date | null;
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

// The one implementation of suspending and lifting an event. The report review reuses
// it for "suspend" instead of repeating the lock, update and audit here.
async function setEventSuspended(
  client: PoolClient,
  eventId: string,
  adminId: string,
  suspend: boolean,
  allowAlreadySuspended = false,
): Promise<SuspensionRow> {
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
    // Reviewing a second report about an event that is already suspended should still
    // close that report. The event itself needs no second suspension or audit entry.
    if (allowAlreadySuspended) return current;
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
}

async function setSuspended(req: Request, suspend: boolean): Promise<SuspensionRow> {
  const eventId = parseId(req.params, 'Event');
  const adminId = req.user!.id;
  return withTransaction((client) => setEventSuspended(client, eventId, adminId, suspend));
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

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

interface UserRow {
  id: string;
  email: string;
  name: string;
  role: string;
  email_verified_at: Date | null;
  suspended_at: Date | null;
  suspended_by: string | null;
  created_at: Date;
}

const USER_COLUMNS = `id, email, name, role, email_verified_at, suspended_at, suspended_by,
         created_at`;

// docs/api.md "Admin: users". Never returns password_hash.
function toAdminUser(row: UserRow) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    email_verified: row.email_verified_at !== null,
    suspended: row.suspended_at !== null,
    suspended_at: row.suspended_at,
    suspended_by: row.suspended_by,
    created_at: row.created_at,
  };
}

// GET /api/admin/users?q=&limit=&offset=
adminRouter.get('/admin/users', requireAuth, requirePlatformAdmin, async (req, res, next) => {
  try {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) throw badRequestFrom(parsed.error, 'query parameter');
    const { limit, offset } = parsed.data;
    const pattern = likePattern(parsed.data.q);

    const result = await pool.query<UserRow>(
      `SELECT ${USER_COLUMNS}
         FROM users
        WHERE ($1::text IS NULL
               OR email ILIKE $1 ESCAPE '\\'
               OR name ILIKE $1 ESCAPE '\\')
        ORDER BY created_at DESC, id DESC
        LIMIT $2 OFFSET $3`,
      [pattern, limit, offset],
    );

    res.json({ users: result.rows.map(toAdminUser), limit, offset });
  } catch (err) {
    next(err);
  }
});

async function setUserSuspended(req: Request, suspend: boolean) {
  const userId = parseId(req.params, 'User');
  const adminId = req.user!.id;

  return withTransaction(async (client) => {
    const found = await client.query<UserRow>(
      `SELECT ${USER_COLUMNS}
         FROM users
        WHERE id = $1
          FOR UPDATE`,
      [userId],
    );
    const current = found.rows[0];
    if (!current) {
      throw AppError.notFound(ErrorCode.USER_NOT_FOUND, 'User not found');
    }

    if (suspend) {
      // SRS 4.12: moderation of accounts, not a way for an admin to lock themselves out
      // or to remove another platform administrator.
      if (current.id === adminId) {
        throw AppError.conflict(ErrorCode.CONFLICT, 'You cannot suspend your own account');
      }
      if (current.role === 'platform_admin') {
        throw AppError.conflict(ErrorCode.CONFLICT, 'A platform administrator cannot be suspended');
      }
      if (current.suspended_at !== null) {
        throw AppError.conflict(ErrorCode.CONFLICT, 'The user is already suspended');
      }
    } else if (current.suspended_at === null) {
      throw AppError.conflict(ErrorCode.CONFLICT, 'The user is not suspended');
    }

    const updated = suspend
      ? await client.query<UserRow>(
          `UPDATE users
              SET suspended_at = now(), suspended_by = $2
            WHERE id = $1
        RETURNING ${USER_COLUMNS}`,
          [userId, adminId],
        )
      : await client.query<UserRow>(
          `UPDATE users
              SET suspended_at = NULL, suspended_by = NULL
            WHERE id = $1
        RETURNING ${USER_COLUMNS}`,
          [userId],
        );

    await recordAudit(client, {
      actorId: adminId,
      action: suspend ? 'user.suspended' : 'user.unsuspended',
      entityType: 'user',
      entityId: userId,
      description: suspend ? 'Suspended the user account' : 'Lifted the user suspension',
    });

    return updated.rows[0]!;
  });
}

// POST /api/admin/users/:id/suspend
adminRouter.post(
  '/admin/users/:id/suspend',
  requireAuth,
  requirePlatformAdmin,
  async (req, res) => {
    res.json({ user: toAdminUser(await setUserSuspended(req, true)) });
  },
);

// POST /api/admin/users/:id/unsuspend
adminRouter.post(
  '/admin/users/:id/unsuspend',
  requireAuth,
  requirePlatformAdmin,
  async (req, res) => {
    res.json({ user: toAdminUser(await setUserSuspended(req, false)) });
  },
);

// ---------------------------------------------------------------------------
// Event search and reported events
// ---------------------------------------------------------------------------

interface AdminEventRow {
  id: string;
  title: string;
  status: string;
  suspended_at: Date | null;
  starts_at: Date;
  ends_at: Date;
  organizer_id: string;
  organizer_name: string;
  organizer_email: string;
  open_reports: number;
}

// docs/api.md "Admin: searching events".
function toAdminEvent(row: AdminEventRow) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    suspended: row.suspended_at !== null,
    suspended_at: row.suspended_at,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    organizer: {
      id: row.organizer_id,
      name: row.organizer_name,
      email: row.organizer_email,
    },
    open_reports: row.open_reports,
  };
}

const ADMIN_EVENT_SELECT = `SELECT e.id,
         e.title,
         e.status,
         e.suspended_at,
         e.starts_at,
         e.ends_at,
         u.id    AS organizer_id,
         u.name  AS organizer_name,
         u.email AS organizer_email,
         (SELECT count(*)::int
            FROM event_reports r
           WHERE r.event_id = e.id
             AND r.status = 'open') AS open_reports
    FROM events e
    JOIN users u ON u.id = e.organizer_id`;

// GET /api/admin/events?q=&status=&limit=&offset=
const eventListQuerySchema = listQuerySchema.extend({
  status: z.enum(['draft', 'published', 'cancelled']).optional(),
});

adminRouter.get('/admin/events', requireAuth, requirePlatformAdmin, async (req, res, next) => {
  try {
    const parsed = eventListQuerySchema.safeParse(req.query);
    if (!parsed.success) throw badRequestFrom(parsed.error, 'query parameter');
    const { limit, offset, status } = parsed.data;
    const pattern = likePattern(parsed.data.q);

    const result = await pool.query<AdminEventRow>(
      `${ADMIN_EVENT_SELECT}
        WHERE ($1::text IS NULL
               OR e.title ILIKE $1 ESCAPE '\\'
               OR u.name ILIKE $1 ESCAPE '\\'
               OR u.email ILIKE $1 ESCAPE '\\')
          AND ($2::text IS NULL OR e.status = $2)
        ORDER BY e.created_at DESC, e.id DESC
        LIMIT $3 OFFSET $4`,
      [pattern, status ?? null, limit, offset],
    );

    res.json({ events: result.rows.map(toAdminEvent), limit, offset });
  } catch (err) {
    next(err);
  }
});

// POST /api/events/:id/report - any logged-in user, on a published, unsuspended event.
const reportBodySchema = z.object({
  reason: z.string().trim().min(1).max(1000),
});

interface ReportRow {
  id: string;
  event_id: string;
  reported_by: string;
  reason: string;
  status: string;
  created_at: Date;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  event_title: string;
  event_status: string;
  event_suspended_at: Date | null;
  reporter_name: string;
  reporter_email: string;
}

const REPORT_SELECT = `SELECT r.id,
         r.event_id,
         r.reported_by,
         r.reason,
         r.status,
         r.created_at,
         r.reviewed_by,
         r.reviewed_at,
         e.title AS event_title,
         e.status AS event_status,
         e.suspended_at AS event_suspended_at,
         u.name AS reporter_name,
         u.email AS reporter_email
    FROM event_reports r
    JOIN events e ON e.id = r.event_id
    JOIN users u ON u.id = r.reported_by`;

// docs/api.md "Admin: reported events".
function toAdminReport(row: ReportRow) {
  return {
    id: row.id,
    event: {
      id: row.event_id,
      title: row.event_title,
      status: row.event_status,
      suspended: row.event_suspended_at !== null,
    },
    reported_by: {
      id: row.reported_by,
      name: row.reporter_name,
      email: row.reporter_email,
    },
    reason: row.reason,
    status: row.status,
    created_at: row.created_at,
    reviewed_by: row.reviewed_by,
    reviewed_at: row.reviewed_at,
  };
}

const PG_UNIQUE_VIOLATION = '23505';

adminRouter.post('/events/:id/report', requireAuth, async (req, res, next) => {
  try {
    const eventId = parseId(req.params, 'Event');
    const parsed = reportBodySchema.safeParse(req.body);
    if (!parsed.success) throw badRequestFrom(parsed.error, 'request body');

    const report = await withTransaction(async (client) => {
      // Sharing the event row means a suspension taking the lock waits for this insert
      // or the other way around, so a report cannot land on an event that just left the
      // public page.
      const found = await client.query<{ id: string }>(
        `SELECT id
           FROM events
          WHERE id = $1
            AND status = 'published'
            AND suspended_at IS NULL
          FOR SHARE`,
        [eventId],
      );
      if (found.rows.length === 0) {
        throw AppError.notFound(ErrorCode.EVENT_NOT_FOUND, 'Event not found');
      }

      let inserted;
      try {
        inserted = await client.query<ReportRow>(
          `INSERT INTO event_reports (event_id, reported_by, reason)
           VALUES ($1, $2, $3)
           RETURNING id, event_id, reported_by, reason, status, created_at,
                     reviewed_by, reviewed_at`,
          [eventId, req.user!.id, parsed.data.reason],
        );
      } catch (err) {
        if ((err as { code?: string }).code === PG_UNIQUE_VIOLATION) {
          throw AppError.conflict(
            ErrorCode.CONFLICT,
            'You already have an open report for this event',
          );
        }
        throw err;
      }

      const row = inserted.rows[0]!;
      const event = await client.query<{
        title: string;
        status: string;
        suspended_at: Date | null;
      }>(`SELECT title, status, suspended_at FROM events WHERE id = $1`, [eventId]);
      const reporter = await client.query<{ name: string; email: string }>(
        `SELECT name, email FROM users WHERE id = $1`,
        [req.user!.id],
      );
      return {
        ...row,
        event_title: event.rows[0]!.title,
        event_status: event.rows[0]!.status,
        event_suspended_at: event.rows[0]!.suspended_at,
        reporter_name: reporter.rows[0]!.name,
        reporter_email: reporter.rows[0]!.email,
      } satisfies ReportRow;
    });

    res.status(201).json({ report: toAdminReport(report) });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/reports?status=open
const reportListQuerySchema = listQuerySchema.extend({
  status: z.enum(['open', 'dismissed', 'actioned']).default('open'),
});

adminRouter.get('/admin/reports', requireAuth, requirePlatformAdmin, async (req, res, next) => {
  try {
    const parsed = reportListQuerySchema.safeParse(req.query);
    if (!parsed.success) throw badRequestFrom(parsed.error, 'query parameter');
    const { limit, offset, status } = parsed.data;

    const result = await pool.query<ReportRow>(
      `${REPORT_SELECT}
        WHERE r.status = $1
        ORDER BY r.created_at ASC, r.id ASC
        LIMIT $2 OFFSET $3`,
      [status, limit, offset],
    );

    res.json({ reports: result.rows.map(toAdminReport), limit, offset });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/reports/:id/resolve { action: "dismiss" | "suspend" }
const resolveReportSchema = z.object({ action: z.enum(['dismiss', 'suspend']) });

interface ReportTargetRow {
  id: string;
  event_id: string;
  status: string;
}

adminRouter.post(
  '/admin/reports/:id/resolve',
  requireAuth,
  requirePlatformAdmin,
  async (req, res, next) => {
    try {
      const reportId = parseId(req.params, 'Report');
      const parsed = resolveReportSchema.safeParse(req.body);
      if (!parsed.success) throw badRequestFrom(parsed.error, 'request body');
      const adminId = req.user!.id;

      const report = await withTransaction(async (client) => {
        const found = await client.query<ReportTargetRow>(
          `SELECT id, event_id, status
             FROM event_reports
            WHERE id = $1
              FOR UPDATE`,
          [reportId],
        );
        const current = found.rows[0];
        if (!current) {
          throw AppError.notFound(ErrorCode.REPORT_NOT_FOUND, 'Report not found');
        }
        if (current.status !== 'open') {
          throw AppError.conflict(ErrorCode.CONFLICT, 'This report has already been resolved');
        }

        if (parsed.data.action === 'dismiss') {
          await client.query(
            `UPDATE event_reports
                SET status = 'dismissed', reviewed_by = $2, reviewed_at = now()
              WHERE id = $1`,
            [reportId, adminId],
          );
          await recordAudit(client, {
            actorId: adminId,
            action: 'event_report.dismissed',
            entityType: 'event_report',
            entityId: reportId,
            eventId: current.event_id,
            description: 'Dismissed the event report',
          });
        } else {
          // Reuse the one suspension implementation, including its lock, update and
          // event.suspended audit entry.
          await setEventSuspended(client, current.event_id, adminId, true, true);
          // Suspending an event actions every open report about it, not only this one:
          // they all described the same event.
          await client.query(
            `UPDATE event_reports
                SET status = 'actioned', reviewed_by = $2, reviewed_at = now()
              WHERE event_id = $1
                AND status = 'open'`,
            [current.event_id, adminId],
          );
        }

        const result = await client.query<ReportRow>(`${REPORT_SELECT} WHERE r.id = $1`, [
          reportId,
        ]);
        return result.rows[0]!;
      });

      res.json({ report: toAdminReport(report) });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Platform settings: the activation fee
// ---------------------------------------------------------------------------

interface SettingsRow {
  id: string;
  activation_fee: number;
  updated_at: Date;
  updated_by: string | null;
}

// docs/api.md "Admin: platform settings". The fee is in tiyn, like all money.
function toSettings(row: SettingsRow) {
  return {
    activation_fee: row.activation_fee,
    currency: 'KZT',
    updated_at: row.updated_at,
    updated_by: row.updated_by,
  };
}

const SETTINGS_SELECT = `SELECT id, activation_fee, updated_at, updated_by
    FROM platform_settings`;

adminRouter.get('/admin/settings', requireAuth, requirePlatformAdmin, async (req, res, next) => {
  try {
    const result = await pool.query<SettingsRow>(`${SETTINGS_SELECT} LIMIT 1`);
    const row = result.rows[0];
    if (!row) {
      throw new AppError(ErrorCode.INTERNAL_ERROR, 'Platform settings are missing', 500);
    }
    res.json({ settings: toSettings(row) });
  } catch (err) {
    next(err);
  }
});

const settingsBodySchema = z.object({
  activation_fee: z.number().int().min(0).max(2_147_483_647),
});

adminRouter.patch('/admin/settings', requireAuth, requirePlatformAdmin, async (req, res, next) => {
  try {
    const parsed = settingsBodySchema.safeParse(req.body);
    if (!parsed.success) throw badRequestFrom(parsed.error, 'request body');
    const adminId = req.user!.id;

    const settings = await withTransaction(async (client) => {
      const locked = await client.query<SettingsRow>(`${SETTINGS_SELECT} LIMIT 1 FOR UPDATE`);
      if (!locked.rows[0]) {
        throw new AppError(ErrorCode.INTERNAL_ERROR, 'Platform settings are missing', 500);
      }

      const updated = await client.query<SettingsRow>(
        `UPDATE platform_settings
              SET activation_fee = $1, updated_by = $2
            WHERE id = $3
        RETURNING id, activation_fee, updated_at, updated_by`,
        [parsed.data.activation_fee, adminId, locked.rows[0].id],
      );
      const row = updated.rows[0]!;

      await recordAudit(client, {
        actorId: adminId,
        action: 'platform_settings.updated',
        entityType: 'platform_settings',
        entityId: row.id,
        description: `Activation fee set to ${(row.activation_fee / 100).toFixed(2)} KZT`,
      });
      return row;
    });

    res.json({ settings: toSettings(settings) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Orders, failed payments and CSV exports
// ---------------------------------------------------------------------------

// A pending order past expires_at reads as cancelled, exactly like GET /api/orders.
const ORDER_STATUS_SQL = `CASE WHEN o.status = 'pending' AND o.expires_at <= now()
                               THEN 'cancelled' ELSE o.status END`;

interface AdminOrderRow extends PaymentColumns, RefundColumns {
  id: string;
  status: string;
  buyer_id: string;
  buyer_name: string;
  buyer_email: string;
  event_id: string;
  event_title: string;
  subtotal: number;
  discount: number;
  processing_fee: number;
  total: number;
  created_at: Date;
  failed_payment_attempts: number;
  last_payment_failed_at: Date | null;
}

const ADMIN_ORDER_SELECT = `SELECT o.id,
         ${ORDER_STATUS_SQL} AS status,
         u.id    AS buyer_id,
         u.name  AS buyer_name,
         u.email AS buyer_email,
         e.id    AS event_id,
         e.title AS event_title,
         o.subtotal,
         o.discount,
         o.processing_fee,
         o.total,
         o.created_at,
         ${PAYMENT_COLUMNS},
         ${REFUND_COLUMNS},
         (SELECT count(*)::int
            FROM audit_log al
           WHERE al.entity_id = o.id
             AND al.action = 'order.payment_failed') AS failed_payment_attempts,
         (SELECT max(al.created_at)
            FROM audit_log al
           WHERE al.entity_id = o.id
             AND al.action = 'order.payment_failed') AS last_payment_failed_at
    FROM orders o
    JOIN users u ON u.id = o.user_id
    JOIN events e ON e.id = o.event_id
    LEFT JOIN payments pay ON pay.order_id = o.id
    LEFT JOIN refunds rf ON rf.order_id = o.id`;

// docs/api.md "Admin: orders". The list includes refunds and failed payment attempts;
// the items and tickets are left out, the same as the organizer order list.
function toAdminOrder(row: AdminOrderRow) {
  return {
    id: row.id,
    status: row.status,
    buyer: { id: row.buyer_id, name: row.buyer_name, email: row.buyer_email },
    event: { id: row.event_id, title: row.event_title },
    subtotal: row.subtotal,
    discount: row.discount,
    processing_fee: row.processing_fee,
    total: row.total,
    created_at: row.created_at,
    payment: toPayment(row),
    refund: toRefund(row),
    failed_payment_attempts: row.failed_payment_attempts,
    last_payment_failed_at: row.last_payment_failed_at,
  };
}

const orderListQuerySchema = listQuerySchema.extend({
  status: z.enum(['pending', 'paid', 'cancelled', 'refunded']).optional(),
});

// The optional q and status are shared by the list and both exports, so a download can
// be the same slice of orders the admin is looking at.
function adminOrderFilter(pattern: string | null, status: string | undefined) {
  return {
    sql: `WHERE ($1::text IS NULL
                 OR o.id::text ILIKE $1 ESCAPE '\\'
                 OR u.email ILIKE $1 ESCAPE '\\')
            AND ($2::text IS NULL OR ${ORDER_STATUS_SQL} = $2)`,
    params: [pattern, status ?? null],
  };
}

adminRouter.get('/admin/orders', requireAuth, requirePlatformAdmin, async (req, res, next) => {
  try {
    const parsed = orderListQuerySchema.safeParse(req.query);
    if (!parsed.success) throw badRequestFrom(parsed.error, 'query parameter');
    const { limit, offset, status } = parsed.data;
    const filter = adminOrderFilter(likePattern(parsed.data.q), status);

    const result = await pool.query<AdminOrderRow>(
      `${ADMIN_ORDER_SELECT}
       ${filter.sql}
       ORDER BY o.created_at DESC, o.id DESC
       LIMIT $3 OFFSET $4`,
      [...filter.params, limit, offset],
    );

    res.json({ orders: result.rows.map(toAdminOrder), limit, offset });
  } catch (err) {
    next(err);
  }
});

function csvCell(value: string | number | boolean | Date | null | undefined): string {
  const text =
    value instanceof Date
      ? value.toISOString()
      : value === null || value === undefined
        ? ''
        : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows: (string | number | boolean | Date | null | undefined)[][]): string {
  return `${rows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`;
}

const kztAmount = (tiyn: number | null): string => (tiyn === null ? '' : (tiyn / 100).toFixed(2));

function csvResponse(res: Response, filename: string, body: string): void {
  res.type('text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(body);
}

// GET /api/admin/export/orders.csv
adminRouter.get(
  '/admin/export/orders.csv',
  requireAuth,
  requirePlatformAdmin,
  async (req, res, next) => {
    try {
      const parsed = orderListQuerySchema.safeParse(req.query);
      if (!parsed.success) throw badRequestFrom(parsed.error, 'query parameter');
      const filter = adminOrderFilter(likePattern(parsed.data.q), parsed.data.status);

      const result = await pool.query<AdminOrderRow>(
        `${ADMIN_ORDER_SELECT}
         ${filter.sql}
         ORDER BY o.created_at DESC, o.id DESC`,
        filter.params,
      );

      const rows = [
        [
          'order_id',
          'status',
          'buyer_name',
          'buyer_email',
          'event_id',
          'event_title',
          'subtotal_kzt',
          'discount_kzt',
          'processing_fee_kzt',
          'total_kzt',
          'created_at',
          'payment_method',
          'payment_amount_kzt',
          'refunded_at',
          'refund_amount_kzt',
          'failed_payment_attempts',
          'last_payment_failed_at',
        ],
        ...result.rows.map((row) => [
          row.id,
          row.status,
          row.buyer_name,
          row.buyer_email,
          row.event_id,
          row.event_title,
          kztAmount(row.subtotal),
          kztAmount(row.discount),
          kztAmount(row.processing_fee),
          kztAmount(row.total),
          row.created_at,
          row.payment_method,
          kztAmount(row.payment_amount),
          row.refund_paid_at,
          kztAmount(row.refund_amount),
          row.failed_payment_attempts,
          row.last_payment_failed_at,
        ]),
      ];
      csvResponse(res, 'biletflow-orders.csv', toCsv(rows));
    } catch (err) {
      next(err);
    }
  },
);

interface RefundExportRow {
  id: string;
  order_id: string;
  buyer_name: string;
  buyer_email: string;
  event_title: string;
  amount: number;
  currency: string;
  method: string;
  is_demonstration: boolean;
  refunded_at: Date;
  refunded_by: string;
}

// GET /api/admin/export/refunds.csv
adminRouter.get(
  '/admin/export/refunds.csv',
  requireAuth,
  requirePlatformAdmin,
  async (req, res, next) => {
    try {
      const parsed = listQuerySchema.safeParse(req.query);
      if (!parsed.success) throw badRequestFrom(parsed.error, 'query parameter');
      const pattern = likePattern(parsed.data.q);

      const result = await pool.query<RefundExportRow>(
        `SELECT rf.id,
                rf.order_id,
                u.name  AS buyer_name,
                u.email AS buyer_email,
                e.title AS event_title,
                rf.amount,
                rf.currency,
                rf.method,
                rf.is_demonstration,
                rf.created_at AS refunded_at,
                rf.refunded_by
           FROM refunds rf
           JOIN orders o ON o.id = rf.order_id
           JOIN users u ON u.id = o.user_id
           JOIN events e ON e.id = o.event_id
          WHERE ($1::text IS NULL
                 OR rf.order_id::text ILIKE $1 ESCAPE '\\'
                 OR u.email ILIKE $1 ESCAPE '\\')
          ORDER BY rf.created_at DESC, rf.id DESC`,
        [pattern],
      );

      const rows = [
        [
          'refund_id',
          'order_id',
          'buyer_name',
          'buyer_email',
          'event_title',
          'amount_kzt',
          'currency',
          'method',
          'is_demonstration',
          'refunded_at',
          'refunded_by',
        ],
        ...result.rows.map((row) => [
          row.id,
          row.order_id,
          row.buyer_name,
          row.buyer_email,
          row.event_title,
          kztAmount(row.amount),
          row.currency,
          row.method,
          row.is_demonstration,
          row.refunded_at,
          row.refunded_by,
        ]),
      ];
      csvResponse(res, 'biletflow-refunds.csv', toCsv(rows));
    } catch (err) {
      next(err);
    }
  },
);
