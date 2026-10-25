/**
 * Simulated refunds (migration 008): how a paid order was given its money back.
 *
 * Nothing here moves money, the same as src/lib/payments.ts. Every refund in the
 * academic MVP is method 'simulated' and is_demonstration true, and the API says so on
 * every refund it returns, because SRS 4.6 forbids presenting demonstration money as
 * real transactions.
 *
 * Queries LEFT JOIN refunds under the alias `rf` and select REFUND_COLUMNS; toRefund()
 * turns those columns into the docs/api.md "refund" object, or null when there is none.
 */

// Constant SQL, never user input, so putting it into a query with ${} is safe.
export const REFUND_COLUMNS = `rf.amount            AS refund_amount,
         rf.currency          AS refund_currency,
         rf.is_demonstration  AS refund_is_demonstration,
         rf.created_at        AS refund_paid_at`;

export interface RefundColumns {
  refund_amount: number | null;
  refund_currency: string | null;
  refund_is_demonstration: boolean | null;
  refund_paid_at: Date | null;
}

// docs/api.md "refund" object.
export function toRefund(row: RefundColumns) {
  if (row.refund_paid_at === null) {
    return null;
  }
  return {
    amount: row.refund_amount,
    currency: row.refund_currency,
    is_demonstration: row.refund_is_demonstration,
    refunded_at: row.refund_paid_at,
  };
}
