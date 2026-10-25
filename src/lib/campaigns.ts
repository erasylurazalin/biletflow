/**
 * Campaign report numbers (docs/decisions.md, decision 11), shared by the campaign
 * endpoints and the event analytics dashboard so both read the same rule. Computed
 * from the database on every read, never stored: redemptions count live ones only, the
 * same rule as held seats, while orders, tickets sold and revenue count paid orders
 * only. Processing fees are not revenue for the organizer and are left out.
 */
import type { PoolClient } from 'pg';

export interface CampaignReport {
  redemptions: number;
  orders: number;
  tickets_sold: number;
  gross_revenue: number;
  discount_total: number;
  net_revenue: number;
}

// A redemption counts while its order is paid, or pending and not expired, the same
// rule as HELD_SQL in routes/ticket-types.ts. Constant SQL, safe to interpolate.
export const LIVE_REDEMPTION_SQL = `(o.status = 'paid'
      OR (o.status = 'pending' AND (o.expires_at IS NULL OR o.expires_at > now())))`;

// One query per campaign: our campaign lists are short, and keeping it to one
// statement per campaign keeps the numbers in one place.
export async function campaignReport(
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
