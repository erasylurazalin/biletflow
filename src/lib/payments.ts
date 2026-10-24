/**
 * Simulated payments (migration 004): what an order or an activation fee was paid with.
 *
 * Nothing here moves money. Every payment in the academic MVP is method 'simulated' and
 * is_demonstration true, and the API says so on every payment it returns, because SRS
 * 4.6 forbids presenting demonstration payments as real transactions.
 *
 * Queries LEFT JOIN payments under the alias `pay` and select PAYMENT_COLUMNS; toPayment()
 * turns those columns into the docs/api.md "payment" object, or null when there is none.
 */

// Constant SQL, never user input, so putting it into a query with ${} is safe.
export const PAYMENT_COLUMNS = `pay.amount           AS payment_amount,
         pay.currency         AS payment_currency,
         pay.method           AS payment_method,
         pay.is_demonstration AS payment_is_demonstration,
         pay.created_at       AS payment_paid_at`;

export interface PaymentColumns {
  payment_amount: number | null;
  payment_currency: string | null;
  payment_method: string | null;
  payment_is_demonstration: boolean | null;
  payment_paid_at: Date | null;
}

// docs/api.md "payment" object.
export function toPayment(row: PaymentColumns) {
  if (row.payment_paid_at === null) {
    return null;
  }
  return {
    method: row.payment_method,
    is_demonstration: row.payment_is_demonstration,
    amount: row.payment_amount,
    currency: row.payment_currency,
    paid_at: row.payment_paid_at,
  };
}
