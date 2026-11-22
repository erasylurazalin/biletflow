/**
 * Support cases and their asynchronous message threads (SRS 4.13, UC9).
 *
 * Two kinds of case. An `event` case is opened by a user with a paid order for that
 * event, with optional order and ticket context. A `platform` case is opened by an
 * organizer about their account, activation, payment or technical problem and has no
 * event context. The participants are the opener and the case's responders:
 *
 *   event    -> events.organizer_id and every row in event_staff for that event
 *   platform -> every user whose role is platform_admin
 *
 * Everybody else gets 404 SUPPORT_CASE_NOT_FOUND on every endpoint, including a
 * platform admin on an event case they are not part of. A participant who is not a
 * responder (normally the opener) can read and reply but gets 403 on PATCH.
 *
 * Status and assignment are the responder's job and never change by themselves.
 * Replies to a resolved case are allowed. Email goes through sendEmail so it lands in
 * email_outbox; see the "Support cases" section of docs/api.md.
 */
import { Router } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { pool } from '../db/pool';
import { withTransaction } from '../db/transaction';
import { recordAudit } from '../lib/audit';
import { AppError, ErrorCode } from '../lib/errors';
import { sendEmail, webUrl } from '../lib/mailer';
import { requireAuth, type AuthUser } from '../middleware/auth';

// Mounted at /api, because the paths start with /support. requireAuth goes on each
// route, never on router.use(): this router sees every /api request, and the public
// ones must not demand a token.
export const supportRouter = Router();

type Db = Pick<PoolClient, 'query'>;

const CATEGORIES = [
  'ticket_delivery',
  'payment',
  'refund',
  'seating',
  'event_information',
  'check_in',
  'account',
  'technical',
] as const;

const STATUSES = ['open', 'in_progress', 'waiting_for_customer', 'resolved'] as const;

const categorySchema = z.enum(CATEGORIES);
const statusSchema = z.enum(STATUSES);

const idParamSchema = z.object({ id: z.uuid() });

function badRequestFrom(error: z.ZodError, what: string): AppError {
  const first = error.issues[0];
  return AppError.badRequest(
    first ? `Invalid ${what} "${first.path.join('.')}": ${first.message}` : `Invalid ${what}`,
  );
}

function parseListQuery(query: unknown) {
  const schema = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).default(0),
    status: statusSchema.optional(),
  });
  const parsed = schema.safeParse(query);
  if (!parsed.success) {
    throw badRequestFrom(parsed.error, 'query parameter');
  }
  return parsed.data;
}

function supportCaseNotFound(): AppError {
  return AppError.notFound(ErrorCode.SUPPORT_CASE_NOT_FOUND, 'Support case not found');
}

interface CaseRow {
  id: string;
  kind: 'event' | 'platform';
  event_id: string | null;
  order_id: string | null;
  ticket_id: string | null;
  opened_by: string;
  category: string;
  subject: string;
  status: string;
  assigned_to: string | null;
  created_at: Date;
  updated_at: Date;
  event_title: string | null;
  organizer_id: string | null;
  opener_name: string;
  assigned_name: string | null;
  last_message_at: Date;
  on_staff: boolean;
}

interface MessageRow {
  id: string;
  case_id: string;
  author_id: string;
  body: string;
  created_at: Date;
  author_name: string;
  is_responder: boolean;
}

interface ResponderRow {
  id: string;
  name: string;
}

// Every case read starts here and adds its own WHERE. $2 is the viewer, used to tell
// whether they are on the event's staff. The participant filter itself is in the list
// query; a single case is filtered in JavaScript after this read so the route can tell
// a stranger (404) from a participant who cannot respond (403).
const CASE_SELECT = `SELECT c.id,
         c.kind,
         c.event_id,
         c.order_id,
         c.ticket_id,
         c.opened_by,
         c.category,
         c.subject,
         c.status,
         c.assigned_to,
         c.created_at,
         c.updated_at,
         e.title      AS event_title,
         e.organizer_id,
         ou.name      AS opener_name,
         au.name      AS assigned_name,
         COALESCE(
           (SELECT max(m.created_at) FROM support_messages m WHERE m.case_id = c.id),
           c.created_at
         ) AS last_message_at,
         EXISTS (
           SELECT 1 FROM event_staff s
            WHERE s.event_id = c.event_id AND s.user_id = $2
         ) AS on_staff
    FROM support_cases c
    JOIN users ou ON ou.id = c.opened_by
    LEFT JOIN users au ON au.id = c.assigned_to
    LEFT JOIN events e ON e.id = c.event_id`;

const MESSAGE_SELECT = `SELECT m.id,
         m.case_id,
         m.author_id,
         m.body,
         m.created_at,
         u.name AS author_name,
         (CASE
           WHEN c.kind = 'event' THEN
             e.organizer_id = m.author_id
             OR EXISTS (
               SELECT 1 FROM event_staff s
                WHERE s.event_id = c.event_id AND s.user_id = m.author_id
             )
           ELSE u.role = 'platform_admin'
         END) AS is_responder
    FROM support_messages m
    JOIN users u ON u.id = m.author_id
    JOIN support_cases c ON c.id = m.case_id
    LEFT JOIN events e ON e.id = c.event_id`;

function isResponder(row: CaseRow, viewer: AuthUser): boolean {
  if (row.kind === 'platform') {
    return viewer.role === 'platform_admin';
  }
  return row.organizer_id === viewer.id || row.on_staff;
}

// The same rule the SQL participant filter uses, kept in one place for the detail and
// message routes. Role comes from the token, like every other authorization check.
function isParticipant(row: CaseRow, viewer: AuthUser): boolean {
  return row.opened_by === viewer.id || isResponder(row, viewer);
}

// docs/api.md "case" object. `role` is the viewer's side of the conversation: the
// person who opened it stays "opener" even if they are also a responder by relation.
function toCase(row: CaseRow, viewer: AuthUser) {
  return {
    id: row.id,
    kind: row.kind,
    event_id: row.event_id,
    event_title: row.event_title,
    order_id: row.order_id,
    ticket_id: row.ticket_id,
    opened_by: row.opened_by,
    opened_by_name: row.opener_name,
    category: row.category,
    subject: row.subject,
    status: row.status,
    assigned_to: row.assigned_to,
    assigned_to_name: row.assigned_name,
    role: row.opened_by === viewer.id ? 'opener' : 'responder',
    last_message_at: row.last_message_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toMessage(row: MessageRow) {
  return {
    id: row.id,
    case_id: row.case_id,
    author_id: row.author_id,
    author_name: row.author_name,
    is_responder: row.is_responder,
    body: row.body,
    created_at: row.created_at,
  };
}

async function loadCase(db: Db, caseId: string, viewer: AuthUser): Promise<CaseRow | undefined> {
  const result = await db.query<CaseRow>(`${CASE_SELECT} WHERE c.id = $1`, [caseId, viewer.id]);
  return result.rows[0];
}

async function loadMessages(db: Db, caseId: string): Promise<MessageRow[]> {
  const result = await db.query<MessageRow>(
    `${MESSAGE_SELECT}
      WHERE m.case_id = $1
      ORDER BY m.created_at ASC, m.id ASC`,
    [caseId],
  );
  return result.rows;
}

async function loadMessage(db: Db, messageId: string): Promise<MessageRow | undefined> {
  const result = await db.query<MessageRow>(`${MESSAGE_SELECT} WHERE m.id = $1`, [messageId]);
  return result.rows[0];
}

async function loadResponders(db: Db, row: CaseRow): Promise<ResponderRow[]> {
  if (row.kind === 'platform') {
    const result = await db.query<ResponderRow>(
      `SELECT id, name FROM users WHERE role = 'platform_admin' ORDER BY name ASC, id ASC`,
    );
    return result.rows;
  }

  // UNION drops the organizer when they also put themselves on the event's staff.
  const result = await db.query<ResponderRow>(
    `SELECT id, name FROM (
       SELECT u.id, u.name
         FROM users u
        WHERE u.id = $2
       UNION
       SELECT u.id, u.name
         FROM event_staff s
         JOIN users u ON u.id = s.user_id
        WHERE s.event_id = $1
     ) r
     ORDER BY r.name ASC, r.id ASC`,
    [row.event_id, row.organizer_id],
  );
  return result.rows;
}

interface EmailTarget {
  id: string;
  email: string;
  name: string;
}

async function loadUser(db: Db, userId: string): Promise<EmailTarget | undefined> {
  const result = await db.query<EmailTarget>(`SELECT id, email, name FROM users WHERE id = $1`, [
    userId,
  ]);
  return result.rows[0];
}

async function emailCaseLink(
  db: Db,
  target: EmailTarget,
  authorId: string,
  caseId: string,
  subject: string,
  openingLine: string,
  kind: string,
  emailSubject: string,
): Promise<void> {
  // Do not mail somebody about a message they wrote themselves. That happens when the
  // opener is also a responder, or when the organizer is the only responder.
  if (target.id === authorId) return;

  await sendEmail(db, {
    userId: target.id,
    to: target.email,
    kind,
    subject: emailSubject,
    body: [
      openingLine,
      `Case: ${subject}`,
      `Open the conversation: ${webUrl()}/support/${caseId}`,
    ].join('\n'),
  });
}

// ---------------------------------------------------------------------------
// POST /api/support/cases  - open a case and write its first message
// ---------------------------------------------------------------------------

const createCaseSchema = z
  .object({
    kind: z.enum(['event', 'platform']),
    event_id: z.uuid().optional(),
    order_id: z.uuid().optional(),
    ticket_id: z.uuid().optional(),
    category: categorySchema,
    subject: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(5000),
  })
  .superRefine((value, ctx) => {
    if (value.kind === 'platform') {
      if (
        value.event_id !== undefined ||
        value.order_id !== undefined ||
        value.ticket_id !== undefined
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['event_id'],
          message: 'A platform case has no event, order or ticket context',
        });
      }
      return;
    }
    if (value.event_id === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['event_id'],
        message: 'An event case needs an event_id',
      });
    }
  });

supportRouter.post('/support/cases', requireAuth, async (req, res, next) => {
  try {
    const parsed = createCaseSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequestFrom(parsed.error, 'field');
    }
    const input = parsed.data;
    const viewer = req.user!;

    const caseId = await withTransaction(async (client) => {
      if (input.kind === 'platform') {
        // The decided rule says an organizer profile and role organizer, checked in
        // the database, not from a token that may predate a profile change.
        const organizer = await client.query<{ role: string; has_profile: boolean }>(
          `SELECT u.role,
                  EXISTS (SELECT 1 FROM organizer_profiles p WHERE p.user_id = u.id) AS has_profile
             FROM users u
            WHERE u.id = $1`,
          [viewer.id],
        );
        const row = organizer.rows[0];
        if (!row || row.role !== 'organizer' || !row.has_profile) {
          throw AppError.forbidden(
            'Only an organizer with a profile can open a platform support case',
          );
        }
      } else {
        const eventId = input.event_id!;
        const event = await client.query<{ id: string }>(
          `SELECT e.id
             FROM events e
            WHERE e.id = $2
              AND EXISTS (
                SELECT 1 FROM orders o
                 WHERE o.event_id = e.id AND o.user_id = $1 AND o.status = 'paid'
              )`,
          [viewer.id, eventId],
        );
        if (!event.rows[0]) {
          throw AppError.notFound(ErrorCode.EVENT_NOT_FOUND, 'Event not found');
        }

        if (input.order_id !== undefined) {
          const order = await client.query(
            `SELECT 1 FROM orders WHERE id = $1 AND user_id = $2 AND event_id = $3`,
            [input.order_id, viewer.id, eventId],
          );
          if (!order.rows[0]) {
            throw AppError.notFound(ErrorCode.ORDER_NOT_FOUND, 'Order not found');
          }
        }

        if (input.ticket_id !== undefined) {
          const ticket = await client.query(
            `SELECT 1
               FROM tickets t
               JOIN order_items oi ON oi.id = t.order_item_id
               JOIN orders o ON o.id = oi.order_id
              WHERE t.id = $1 AND o.user_id = $2 AND t.event_id = $3`,
            [input.ticket_id, viewer.id, eventId],
          );
          if (!ticket.rows[0]) {
            throw AppError.notFound(ErrorCode.TICKET_NOT_FOUND, 'Ticket not found');
          }
        }
      }

      const inserted = await client.query<{ id: string }>(
        `INSERT INTO support_cases
           (kind, event_id, order_id, ticket_id, opened_by, category, subject, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'open')
         RETURNING id`,
        [
          input.kind,
          input.event_id ?? null,
          input.order_id ?? null,
          input.ticket_id ?? null,
          viewer.id,
          input.category,
          input.subject,
        ],
      );
      const id = inserted.rows[0]!.id;

      await client.query(
        `INSERT INTO support_messages (case_id, author_id, body) VALUES ($1, $2, $3)`,
        [id, viewer.id, input.body],
      );

      await recordAudit(client, {
        actorId: viewer.id,
        action: 'support_case.opened',
        entityType: 'support_case',
        entityId: id,
        eventId: input.kind === 'event' ? input.event_id : null,
        description: `Opened a ${input.kind} support case: ${input.subject}`,
      });

      return id;
    });

    const row = await loadCase(pool, caseId, viewer);
    if (!row) {
      throw supportCaseNotFound();
    }
    res.status(201).json({ case: toCase(row, viewer) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/support/cases  - every case I participate in, newest activity first
// ---------------------------------------------------------------------------

supportRouter.get('/support/cases', requireAuth, async (req, res, next) => {
  try {
    const { limit, offset, status } = parseListQuery(req.query);
    const viewer = req.user!;

    const result = await pool.query<CaseRow>(
      `${CASE_SELECT}
        WHERE ($3::text IS NULL OR c.status = $3)
          AND (
            c.opened_by = $2
            OR (c.kind = 'event' AND (
                 e.organizer_id = $2
                 OR EXISTS (
                   SELECT 1 FROM event_staff s
                    WHERE s.event_id = c.event_id AND s.user_id = $2
                 )
               ))
            OR (c.kind = 'platform' AND $4::text = 'platform_admin')
          )
        ORDER BY last_message_at DESC, c.id DESC
        LIMIT $1 OFFSET $5`,
      [limit, viewer.id, status ?? null, viewer.role, offset],
    );

    res.json({ cases: result.rows.map((row) => toCase(row, viewer)), limit, offset });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/support/cases/:id  - one case and its thread
// ---------------------------------------------------------------------------

supportRouter.get('/support/cases/:id', requireAuth, async (req, res, next) => {
  try {
    const params = idParamSchema.safeParse(req.params);
    if (!params.success) {
      throw AppError.badRequest('Support case id must be a UUID');
    }
    const viewer = req.user!;

    const row = await loadCase(pool, params.data.id, viewer);
    if (!row || !isParticipant(row, viewer)) {
      throw supportCaseNotFound();
    }

    const [messages, responders] = await Promise.all([
      loadMessages(pool, row.id),
      loadResponders(pool, row),
    ]);

    res.json({
      case: { ...toCase(row, viewer), responders },
      messages: messages.map(toMessage),
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/support/cases/:id/messages  - reply, even after the case is resolved
// ---------------------------------------------------------------------------

const replySchema = z.object({ body: z.string().trim().min(1).max(5000) });

supportRouter.post('/support/cases/:id/messages', requireAuth, async (req, res, next) => {
  try {
    const params = idParamSchema.safeParse(req.params);
    if (!params.success) {
      throw AppError.badRequest('Support case id must be a UUID');
    }
    const parsed = replySchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequestFrom(parsed.error, 'field');
    }
    const viewer = req.user!;
    const caseId = params.data.id;

    const messageId = await withTransaction(async (client) => {
      // The lock serializes replies with a status or assignment change on the same
      // case, so the email target and the audit entry describe one state.
      const locked = await client.query(`SELECT id FROM support_cases WHERE id = $1 FOR UPDATE`, [
        caseId,
      ]);
      if (!locked.rows[0]) {
        throw supportCaseNotFound();
      }

      const row = await loadCase(client, caseId, viewer);
      if (!row || !isParticipant(row, viewer)) {
        throw supportCaseNotFound();
      }

      const author = await loadUser(client, viewer.id);
      if (!author) {
        throw supportCaseNotFound();
      }

      const inserted = await client.query<{ id: string }>(
        `INSERT INTO support_messages (case_id, author_id, body)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [caseId, viewer.id, parsed.data.body],
      );
      const id = inserted.rows[0]!.id;

      // last_message_at reads messages, but updated_at should also say "activity".
      await client.query(`UPDATE support_cases SET updated_at = now() WHERE id = $1`, [caseId]);

      if (row.opened_by === viewer.id) {
        // The opener wrote. Notify the assignee, else the event's organizer for an
        // event case, and nobody for a platform case with no assignee.
        let target: EmailTarget | undefined;
        if (row.assigned_to) {
          target = await loadUser(client, row.assigned_to);
        } else if (row.kind === 'event' && row.organizer_id) {
          target = await loadUser(client, row.organizer_id);
        }
        if (target) {
          await emailCaseLink(
            client,
            target,
            viewer.id,
            caseId,
            row.subject,
            `${author.name} replied to a support case you respond to.`,
            'support_reply',
            'New reply to a support case',
          );
        }
      } else {
        // A responder wrote. The opener is always told.
        const opener = await loadUser(client, row.opened_by);
        if (opener) {
          await emailCaseLink(
            client,
            opener,
            viewer.id,
            caseId,
            row.subject,
            `${author.name} replied to your support case.`,
            'support_reply',
            'New reply to your support case',
          );
        }
      }

      return id;
    });

    const message = await loadMessage(pool, messageId);
    if (!message) {
      throw supportCaseNotFound();
    }
    res.status(201).json({ message: toMessage(message) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/support/cases/:id  - responder changes status or assignment
// ---------------------------------------------------------------------------

const patchCaseSchema = z
  .object({
    status: statusSchema.optional(),
    // null clears the assignment. The responder check below runs only for a uuid.
    assigned_to: z.uuid().nullable().optional(),
  })
  .refine((value) => value.status !== undefined || value.assigned_to !== undefined, {
    message: 'Send status or assigned_to',
  });

interface ResponderNameRow {
  id: string;
  name: string;
}

supportRouter.patch('/support/cases/:id', requireAuth, async (req, res, next) => {
  try {
    const params = idParamSchema.safeParse(req.params);
    if (!params.success) {
      throw AppError.badRequest('Support case id must be a UUID');
    }
    const parsed = patchCaseSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequestFrom(parsed.error, 'field');
    }
    const viewer = req.user!;
    const caseId = params.data.id;
    const input = parsed.data;

    await withTransaction(async (client) => {
      const locked = await client.query(`SELECT id FROM support_cases WHERE id = $1 FOR UPDATE`, [
        caseId,
      ]);
      if (!locked.rows[0]) {
        throw supportCaseNotFound();
      }

      const row = await loadCase(client, caseId, viewer);
      if (!row || !isParticipant(row, viewer)) {
        throw supportCaseNotFound();
      }
      if (!isResponder(row, viewer)) {
        throw AppError.forbidden('Only a responder can change this support case');
      }

      const newStatus = input.status ?? row.status;
      const hasAssignment = input.assigned_to !== undefined;
      const newAssignedTo = hasAssignment ? (input.assigned_to ?? null) : row.assigned_to;
      const statusChanged = newStatus !== row.status;
      const assignmentChanged = hasAssignment && newAssignedTo !== row.assigned_to;

      let assignedName: string | null = null;
      if (assignmentChanged && newAssignedTo !== null) {
        const check =
          row.kind === 'event'
            ? await client.query<ResponderNameRow>(
                `SELECT u.id, left(u.name, 200) AS name
                   FROM users u
                  WHERE u.id = $1
                    AND (
                      u.id = $2
                      OR EXISTS (
                        SELECT 1 FROM event_staff s
                         WHERE s.event_id = $3 AND s.user_id = u.id
                      )
                    )`,
                [newAssignedTo, row.organizer_id, row.event_id],
              )
            : await client.query<ResponderNameRow>(
                `SELECT u.id, left(u.name, 200) AS name
                   FROM users u
                  WHERE u.id = $1 AND u.role = 'platform_admin'`,
                [newAssignedTo],
              );
        const responder = check.rows[0];
        if (!responder) {
          throw AppError.badRequest('assigned_to must be a responder of this case');
        }
        assignedName = responder.name;
      }

      if (statusChanged || assignmentChanged) {
        await client.query(
          `UPDATE support_cases
              SET status = $2, assigned_to = $3
            WHERE id = $1`,
          [caseId, newStatus, newAssignedTo],
        );
      }

      if (statusChanged) {
        await recordAudit(client, {
          actorId: viewer.id,
          action: 'support_case.status_changed',
          entityType: 'support_case',
          entityId: caseId,
          eventId: row.event_id,
          description: `Changed the support case status from ${row.status} to ${newStatus}`,
        });

        const opener = await loadUser(client, row.opened_by);
        if (opener) {
          // Status values are snake_case in the API; the email reads like a sentence.
          const from = row.status.replace(/_/g, ' ');
          const to = newStatus.replace(/_/g, ' ');
          await emailCaseLink(
            client,
            opener,
            viewer.id,
            caseId,
            row.subject,
            `The status of your support case changed from ${from} to ${to}.`,
            'support_status_changed',
            'Support case status changed',
          );
        }
      }

      if (assignmentChanged) {
        await recordAudit(client, {
          actorId: viewer.id,
          action: 'support_case.assigned',
          entityType: 'support_case',
          entityId: caseId,
          eventId: row.event_id,
          description: assignedName
            ? `Assigned the support case to ${assignedName}`
            : 'Unassigned the support case',
        });
      }
    });

    const row = await loadCase(pool, caseId, viewer);
    if (!row) {
      throw supportCaseNotFound();
    }
    const responders = await loadResponders(pool, row);
    res.json({ case: { ...toCase(row, viewer), responders } });
  } catch (err) {
    next(err);
  }
});
