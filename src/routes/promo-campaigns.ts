/**
 * Promo campaigns and campaign QR codes (SRS 4.14, UC10). Same layering as
 * routes/organizer-orders.ts.
 *
 * A campaign belongs to one event and gives a discount on the ticket types it covers
 * (all of them when ticket_type_ids is null). Each campaign carries a `code` the buyer
 * types at checkout and an opaque `token` that goes into the campaign link
 * ${webUrl()}/events/<event id>?promo=<token>. The link never contains the discount or
 * any price, and the QR code is a picture of exactly that link, in dark blue on white
 * so it looks different from the black admission tickets. It is not a ticket: check-in
 * (src/lib/qr.ts) refuses anything that is not a signed BF1: payload, and must keep
 * doing so.
 *
 * Reporting (docs/decisions.md, decision 11): redemptions count live ones only, the
 * same rule as held seats, while orders, tickets sold and revenue count paid orders
 * only. Processing fees are not revenue for the organizer and are left out.
 *
 * Only the event's organizer manages its campaigns: anyone else gets 403, a missing
 * event 404 EVENT_NOT_FOUND and a missing campaign 404 PROMO_CAMPAIGN_NOT_FOUND.
 */
import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import type { PoolClient } from 'pg';
import QRCode from 'qrcode';
import { z } from 'zod';
import { pool } from '../db/pool';
import { withTransaction } from '../db/transaction';
import { recordAudit } from '../lib/audit';
import { AppError, ErrorCode } from '../lib/errors';
import { webUrl } from '../lib/mailer';
import { requireAuth } from '../middleware/auth';
import { HELD_SQL } from './ticket-types';

// Mounted at /api, because the paths start in two places (/events/:id/promo-campaigns
// and /promo-campaigns/:id) and the public /promo/:token. requireAuth goes on each
// route, never on router.use(): this router sees every /api request, and the public
// ones must not demand a token.
export const promoCampaignsRouter = Router();

// Postgres error code for a unique violation: the chosen or generated code is taken.
const PG_UNIQUE_VIOLATION = '23505';

// A generated code is 8 characters of A-Z and 0-9. 36 does not divide 256, so bytes
// >= 252 are thrown away instead of biasing the pick (same idea as the ticket code in
// routes/orders.ts, whose alphabet is exactly 32).
const CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const GENERATED_CODE_LENGTH = 8;

function generateCode(): string {
  let out = '';
  while (out.length < GENERATED_CODE_LENGTH) {
    for (const byte of randomBytes(GENERATED_CODE_LENGTH - out.length)) {
      if (byte < 252) {
        out += CODE_ALPHABET[byte % 36];
      }
    }
  }
  return out;
}

// The link a campaign QR code is a picture of. It carries the opaque token and
// nothing else: no discount, no price.
function campaignLink(eventId: string, token: string): string {
  return `${webUrl()}/events/${eventId}?promo=${token}`;
}

interface CampaignDbRow {
  id: string;
  event_id: string;
  name: string;
  code: string;
  token: string;
  discount_type: 'percent' | 'fixed';
  discount_value: number;
  starts_at: Date | null;
  ends_at: Date | null;
  max_redemptions: number | null;
  ticket_type_ids: string[] | null;
  is_active: boolean;
  created_at: Date;
}

// The rule 11 numbers, computed from the database, never stored (docs/decisions.md).
interface CampaignReport {
  redemptions: number;
  orders: number;
  tickets_sold: number;
  gross_revenue: number;
  discount_total: number;
  net_revenue: number;
}

// A redemption counts while its order is paid, or pending and not expired, the same
// rule as HELD_SQL in routes/ticket-types.ts. Constant SQL, safe to interpolate.
const LIVE_REDEMPTION_SQL = `(o.status = 'paid'
      OR (o.status = 'pending' AND (o.expires_at IS NULL OR o.expires_at > now())))`;

// One query per campaign: our campaign lists are short, and keeping it to one
// statement per campaign keeps the numbers in one place.
async function campaignReport(
  db: Pick<PoolClient, 'query'>,
  campaignId: string,
): Promise<CampaignReport> {
  const result = await db.query<{
    redemptions: number;
    orders: number;
    tickets_sold: number;
    gross_revenue: number;
    discount_total: number;
  }>(
    `SELECT
       count(r.id) FILTER (WHERE ${LIVE_REDEMPTION_SQL})::int AS redemptions,
       count(r.id) FILTER (WHERE o.status = 'paid')::int AS orders,
       COALESCE((SELECT sum(oi.quantity)::int
                   FROM promo_redemptions r2
                   JOIN order_items oi ON oi.order_id = r2.order_id
                   JOIN orders o2 ON o2.id = r2.order_id
                  WHERE r2.campaign_id = pc.id AND o2.status = 'paid'), 0) AS tickets_sold,
       COALESCE(sum(o.subtotal) FILTER (WHERE o.status = 'paid'), 0)::int AS gross_revenue,
       COALESCE(sum(r.discount_amount) FILTER (WHERE o.status = 'paid'), 0)::int AS discount_total
      FROM promo_campaigns pc
      LEFT JOIN promo_redemptions r ON r.campaign_id = pc.id
      LEFT JOIN orders o ON o.id = r.order_id
     WHERE pc.id = $1
     GROUP BY pc.id`,
    [campaignId],
  );
  const row = result.rows[0];
  return {
    redemptions: row?.redemptions ?? 0,
    orders: row?.orders ?? 0,
    tickets_sold: row?.tickets_sold ?? 0,
    gross_revenue: row?.gross_revenue ?? 0,
    discount_total: row?.discount_total ?? 0,
    net_revenue: (row?.gross_revenue ?? 0) - (row?.discount_total ?? 0),
  };
}

// docs/api.md "campaign" object: everything a campaign is, plus the link and the
// report numbers.
function toCampaign(row: CampaignDbRow, report: CampaignReport) {
  return {
    id: row.id,
    event_id: row.event_id,
    name: row.name,
    code: row.code,
    token: row.token,
    discount_type: row.discount_type,
    discount_value: row.discount_value,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    max_redemptions: row.max_redemptions,
    ticket_type_ids: row.ticket_type_ids,
    is_active: row.is_active,
    created_at: row.created_at,
    link: campaignLink(row.event_id, row.token),
    ...report,
  };
}

function badRequestFrom(error: z.ZodError, what: string): AppError {
  const first = error.issues[0];
  return AppError.badRequest(
    first ? `Invalid ${what} "${first.path.join('.')}": ${first.message}` : `Invalid ${what}`,
  );
}

function forbidden(): AppError {
  return AppError.forbidden("Only the event's organizer can manage its campaigns");
}

const eventIdParamSchema = z.object({ id: z.uuid() });
const campaignIdParamSchema = z.object({ id: z.uuid() });

// 404 EVENT_NOT_FOUND if the event does not exist, 403 if it is not mine.
async function loadOwnEvent(eventId: string, userId: string): Promise<void> {
  const result = await pool.query<{ organizer_id: string }>(
    `SELECT organizer_id FROM events WHERE id = $1`,
    [eventId],
  );
  const event = result.rows[0];
  if (!event) {
    throw AppError.notFound(ErrorCode.EVENT_NOT_FOUND, 'Event not found');
  }
  if (event.organizer_id !== userId) {
    throw forbidden();
  }
}

interface OwnedCampaignRow extends CampaignDbRow {
  organizer_id: string;
}

// 404 PROMO_CAMPAIGN_NOT_FOUND if there is no such campaign, 403 if its event is not
// mine. The same shape as loadOwnEvent().
async function loadOwnedCampaign(id: string, userId: string): Promise<OwnedCampaignRow> {
  const result = await pool.query<OwnedCampaignRow>(
    `SELECT pc.id,
            pc.event_id,
            pc.name,
            pc.code,
            pc.token,
            pc.discount_type,
            pc.discount_value,
            pc.starts_at,
            pc.ends_at,
            pc.max_redemptions,
            pc.ticket_type_ids,
            pc.is_active,
            pc.created_at,
            e.organizer_id
       FROM promo_campaigns pc
       JOIN events e ON e.id = pc.event_id
      WHERE pc.id = $1`,
    [id],
  );
  const row = result.rows[0];
  if (!row) {
    throw AppError.notFound(ErrorCode.PROMO_CAMPAIGN_NOT_FOUND, 'Promo campaign not found');
  }
  if (row.organizer_id !== userId) {
    throw forbidden();
  }
  return row;
}

// Timestamps arrive as ISO 8601 strings. null clears one, like routes/ticket-types.ts.
const timestampSchema = z.iso
  .datetime({ offset: true })
  .transform((s) => new Date(s))
  .nullable();

const createSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    discount_type: z.enum(['percent', 'fixed']),
    discount_value: z.number().int(),
    // The organizer may choose the code; it is stored upper-case and matched
    // case-insensitively. Left out, the server generates one.
    code: z
      .string()
      .trim()
      .regex(/^[a-zA-Z0-9]{6,20}$/, 'must be 6 to 20 characters of A-Z and 0-9')
      .transform((s) => s.toUpperCase())
      .optional(),
    starts_at: timestampSchema.default(null),
    ends_at: timestampSchema.default(null),
    max_redemptions: z.number().int().min(1).max(1_000_000).nullable().default(null),
    ticket_type_ids: z.array(z.uuid()).min(1).nullable().default(null),
  })
  .refine(
    (v) =>
      v.discount_type === 'percent'
        ? v.discount_value >= 1 && v.discount_value <= 100
        : v.discount_value >= 1,
    'discount_value must be 1 to 100 for a percent discount and above 0 for a fixed one',
  );

// ---------------------------------------------------------------------------
// POST /api/events/:id/promo-campaigns  - add a campaign to my event
// ---------------------------------------------------------------------------

promoCampaignsRouter.post('/events/:id/promo-campaigns', requireAuth, async (req, res, next) => {
  try {
    const params = eventIdParamSchema.safeParse(req.params);
    if (!params.success) {
      throw AppError.badRequest('Event id must be a UUID');
    }
    const body = createSchema.safeParse(req.body);
    if (!body.success) {
      throw badRequestFrom(body.error, 'field');
    }
    const input = body.data;
    const eventId = params.data.id;
    if (input.starts_at && input.ends_at && input.ends_at <= input.starts_at) {
      throw AppError.badRequest('ends_at must be after starts_at');
    }

    const campaign = await withTransaction(async (client) => {
      const eventResult = await client.query<{ organizer_id: string }>(
        `SELECT organizer_id FROM events WHERE id = $1`,
        [eventId],
      );
      const event = eventResult.rows[0];
      if (!event) {
        throw AppError.notFound(ErrorCode.EVENT_NOT_FOUND, 'Event not found');
      }
      if (event.organizer_id !== req.user!.id) {
        throw forbidden();
      }

      // When a list is given, every id must belong to this event, hidden types
      // included: a code for another event's tickets would discount nothing anyway,
      // but it would also look broken in the report.
      if (input.ticket_type_ids) {
        const known = await client.query<{ id: string }>(
          `SELECT id FROM ticket_types WHERE id = ANY($1::uuid[]) AND event_id = $2`,
          [input.ticket_type_ids, eventId],
        );
        if (known.rows.length !== input.ticket_type_ids.length) {
          throw AppError.badRequest('Every ticket type of a campaign must belong to this event');
        }
      }

      // Inserting is also how a taken code is found: the unique index on upper(code)
      // decides, even when two requests race. A chosen code goes back as 409; a
      // generated one is simply drawn again.
      let created: CampaignDbRow | undefined;
      for (let attempt = 0; !created && attempt < 5; attempt++) {
        const code = input.code ?? generateCode();
        try {
          const result = await client.query<CampaignDbRow>(
            `INSERT INTO promo_campaigns
                 (event_id, name, code, token, discount_type, discount_value,
                  starts_at, ends_at, max_redemptions, ticket_type_ids, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             RETURNING id, event_id, name, code, token, discount_type, discount_value,
                       starts_at, ends_at, max_redemptions, ticket_type_ids, is_active,
                       created_at`,
            [
              eventId,
              input.name,
              code,
              randomBytes(24).toString('base64url'),
              input.discount_type,
              input.discount_value,
              input.starts_at,
              input.ends_at,
              input.max_redemptions,
              input.ticket_type_ids,
              req.user!.id,
            ],
          );
          created = result.rows[0];
        } catch (err) {
          const pgError = err as { code?: string; constraint?: string };
          if (
            pgError.code !== PG_UNIQUE_VIOLATION ||
            pgError.constraint !== 'promo_campaigns_code_key'
          ) {
            throw err;
          }
          if (input.code) {
            throw AppError.conflict(ErrorCode.CONFLICT, 'This promo code is already taken');
          }
        }
      }
      if (!created) {
        throw new AppError(ErrorCode.INTERNAL_ERROR, 'Could not generate a free promo code', 500);
      }

      await recordAudit(client, {
        actorId: req.user!.id,
        action: 'promo_code.created',
        entityType: 'promo_code',
        entityId: created.id,
        eventId,
        description: `Created promo code ${created.code} for "${created.name}"`,
      });

      return created;
    });

    res.status(201).json({
      campaign: toCampaign(campaign, await campaignReport(pool, campaign.id)),
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/events/:id/promo-campaigns  - my event's campaigns, newest first
// ---------------------------------------------------------------------------

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

promoCampaignsRouter.get('/events/:id/promo-campaigns', requireAuth, async (req, res, next) => {
  try {
    const params = eventIdParamSchema.safeParse(req.params);
    if (!params.success) {
      throw AppError.badRequest('Event id must be a UUID');
    }
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw badRequestFrom(parsed.error, 'query parameter');
    }
    const { limit, offset } = parsed.data;
    const eventId = params.data.id;

    await loadOwnEvent(eventId, req.user!.id);

    const result = await pool.query<CampaignDbRow>(
      `SELECT id, event_id, name, code, token, discount_type, discount_value,
              starts_at, ends_at, max_redemptions, ticket_type_ids, is_active, created_at
         FROM promo_campaigns
        WHERE event_id = $1
        ORDER BY created_at DESC, id
        LIMIT $2 OFFSET $3`,
      [eventId, limit, offset],
    );
    const campaigns = await Promise.all(
      result.rows.map(async (row) => toCampaign(row, await campaignReport(pool, row.id))),
    );

    // The create form offers the event's ticket types, hidden ones included, and the
    // public event detail leaves hidden types out. So the list carries them.
    const ticketTypes = await pool.query<{
      id: string;
      name: string;
      price: number;
      is_hidden: boolean;
    }>(
      `SELECT id, name, price, is_hidden
         FROM ticket_types
        WHERE event_id = $1
        ORDER BY price ASC, name ASC`,
      [eventId],
    );

    res.json({ campaigns, ticket_types: ticketTypes.rows, limit, offset });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/promo-campaigns/:id  - switch a campaign on or off
// ---------------------------------------------------------------------------

const updateSchema = z.object({ is_active: z.boolean() });

promoCampaignsRouter.patch('/promo-campaigns/:id', requireAuth, async (req, res, next) => {
  try {
    const params = campaignIdParamSchema.safeParse(req.params);
    if (!params.success) {
      throw AppError.badRequest('Campaign id must be a UUID');
    }
    const body = updateSchema.safeParse(req.body);
    if (!body.success) {
      throw badRequestFrom(body.error, 'field');
    }

    const updated = await withTransaction(async (client) => {
      const existingResult = await client.query<OwnedCampaignRow>(
        `SELECT pc.id,
                pc.event_id,
                pc.name,
                pc.code,
                pc.token,
                pc.discount_type,
                pc.discount_value,
                pc.starts_at,
                pc.ends_at,
                pc.max_redemptions,
                pc.ticket_type_ids,
                pc.is_active,
                pc.created_at,
                e.organizer_id
           FROM promo_campaigns pc
           JOIN events e ON e.id = pc.event_id
          WHERE pc.id = $1
          FOR UPDATE OF pc`,
        [params.data.id],
      );
      const existing = existingResult.rows[0];
      if (!existing) {
        throw AppError.notFound(ErrorCode.PROMO_CAMPAIGN_NOT_FOUND, 'Promo campaign not found');
      }
      if (existing.organizer_id !== req.user!.id) {
        throw forbidden();
      }

      const result = await client.query<CampaignDbRow>(
        `UPDATE promo_campaigns SET is_active = $2 WHERE id = $1
         RETURNING id, event_id, name, code, token, discount_type, discount_value,
                   starts_at, ends_at, max_redemptions, ticket_type_ids, is_active,
                   created_at`,
        [existing.id, body.data.is_active],
      );
      const row = result.rows[0]!;

      // Going off is an audited decision; coming back on is not (docs/api.md).
      if (existing.is_active && !body.data.is_active) {
        await recordAudit(client, {
          actorId: req.user!.id,
          action: 'promo_code.disabled',
          entityType: 'promo_code',
          entityId: row.id,
          eventId: row.event_id,
          description: `Disabled promo code ${row.code} for "${row.name}"`,
        });
      }
      return row;
    });

    res.json({
      campaign: toCampaign(updated, await campaignReport(pool, updated.id)),
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/promo-campaigns/:id/qr.png  - the campaign QR code as a PNG
// ---------------------------------------------------------------------------

promoCampaignsRouter.get('/promo-campaigns/:id/qr.png', requireAuth, async (req, res, next) => {
  try {
    const params = campaignIdParamSchema.safeParse(req.params);
    if (!params.success) {
      throw AppError.badRequest('Campaign id must be a UUID');
    }

    const campaign = await loadOwnedCampaign(params.data.id, req.user!.id);

    // Dark blue on white so a campaign code never looks like the black admission
    // tickets on the same phone (SRS 4.14: the two kinds of code must not be
    // confused). The picture encodes the campaign link and nothing else.
    const png = await QRCode.toBuffer(campaignLink(campaign.event_id, campaign.token), {
      type: 'png',
      width: 512,
      margin: 2,
      color: { dark: '#1d4ed8ff', light: '#ffffffff' },
    });
    res.type('image/png').send(png);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/promo/:token  - public: what a campaign link promises
// ---------------------------------------------------------------------------

// The covered ticket types with the details the event page needs to show them, hidden
// ones included: names for the "off which tickets" line, prices and availability so
// they can be ordered like any other type once the code is applied.
interface PromoTicketTypeRow {
  id: string;
  name: string;
  price: number;
  quantity_available: number;
}

promoCampaignsRouter.get('/promo/:token', async (req, res, next) => {
  try {
    // The token is the link's only secret and is never shown as text, so a loose
    // length check is enough: anything that is not a token simply finds no row.
    const token = typeof req.params.token === 'string' ? req.params.token : '';
    if (token.length < 10 || token.length > 100) {
      throw AppError.notFound(ErrorCode.PROMO_CAMPAIGN_NOT_FOUND, 'Promo campaign not found');
    }

    const result = await pool.query<CampaignDbRow & { not_started: boolean; expired: boolean }>(
      `SELECT pc.id, pc.event_id, pc.name, pc.code, pc.token, pc.discount_type,
              pc.discount_value, pc.starts_at, pc.ends_at, pc.max_redemptions,
              pc.ticket_type_ids, pc.is_active, pc.created_at,
              (pc.starts_at IS NOT NULL AND now() < pc.starts_at) AS not_started,
              (pc.ends_at IS NOT NULL AND pc.ends_at <= now()) AS expired
         FROM promo_campaigns pc
        WHERE pc.token = $1`,
      [token],
    );
    const campaign = result.rows[0];
    // An unknown token and a stopped campaign read the same: the link is dead.
    if (!campaign || !campaign.is_active || campaign.not_started || campaign.expired) {
      throw AppError.notFound(ErrorCode.PROMO_CAMPAIGN_NOT_FOUND, 'Promo campaign not found');
    }

    const covered = campaign.ticket_type_ids
      ? `WHERE tt.id = ANY($2::uuid[])`
      : `WHERE tt.event_id = $1 AND tt.is_hidden = false`;
    const types = await pool.query<PromoTicketTypeRow>(
      `SELECT tt.id, tt.name, tt.price,
              tt.quantity_total - ${HELD_SQL} AS quantity_available
         FROM ticket_types tt
        ${covered}
        ORDER BY tt.price ASC, tt.name ASC`,
      campaign.ticket_type_ids
        ? [campaign.event_id, campaign.ticket_type_ids]
        : [campaign.event_id],
    );

    res.json({
      promo: {
        code: campaign.code,
        event_id: campaign.event_id,
        campaign_name: campaign.name,
        discount_type: campaign.discount_type,
        discount_value: campaign.discount_value,
        ticket_type_ids: campaign.ticket_type_ids,
        starts_at: campaign.starts_at,
        ends_at: campaign.ends_at,
        ticket_types: types.rows,
      },
    });
  } catch (err) {
    next(err);
  }
});
