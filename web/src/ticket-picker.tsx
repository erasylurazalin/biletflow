'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ApiError, createOrder, formatPrice, formatWhen, type TicketType } from '@/api';
import { clearSession, readToken } from '@/session';

function unavailableReason(ticket: TicketType, paidSalesActive: boolean): string | null {
  if (ticket.quantity_available === 0) return 'Sold out';
  if (ticket.price > 0 && !paidSalesActive) return 'Not on sale yet';

  const now = Date.now();
  if (ticket.sales_start_at && now < new Date(ticket.sales_start_at).getTime()) {
    return `On sale from ${formatWhen(ticket.sales_start_at)}`;
  }
  if (ticket.sales_end_at && now > new Date(ticket.sales_end_at).getTime()) {
    return 'Sales ended';
  }
  return null;
}

export function TicketPicker({
  eventId,
  ticketTypes,
  paidSalesActive,
}: {
  eventId: string;
  ticketTypes: TicketType[];
  paidSalesActive: boolean;
}) {
  const router = useRouter();
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedCount = ticketTypes.reduce(
    (sum, ticket) => sum + (quantities[ticket.id] ?? 0),
    0,
  );
  const total = ticketTypes.reduce(
    (sum, ticket) => sum + ticket.price * (quantities[ticket.id] ?? 0),
    0,
  );
  const loginPath = `/login?next=${encodeURIComponent(`/events/${eventId}`)}`;

  async function continueToOrder() {
    if (pending || selectedCount === 0 || selectedCount > 10) return;

    const token = readToken();
    if (!token) {
      router.push(loginPath);
      return;
    }

    const items = ticketTypes.flatMap((ticket) => {
      const quantity = quantities[ticket.id] ?? 0;
      return quantity > 0 ? [{ ticket_type_id: ticket.id, quantity }] : [];
    });

    setError(null);
    setPending(true);
    try {
      const order = await createOrder(token, eventId, items);
      router.push(`/orders/${order.id}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        clearSession();
        router.replace(loginPath);
        return;
      }
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <ul className="space-y-3">
        {ticketTypes.map((ticket) => {
          const reason = unavailableReason(ticket, paidSalesActive);
          const maximum = Math.min(10, ticket.quantity_available);
          return (
            <li
              key={ticket.id}
              className="flex items-center justify-between gap-4 rounded-lg border border-zinc-200 bg-white p-4"
            >
              <div>
                <div className="font-medium">{ticket.name}</div>
                <div className="text-sm text-zinc-500">{formatPrice(ticket.price)}</div>
                <div className="mt-1 text-sm text-zinc-500">{ticket.quantity_available} left</div>
              </div>
              {reason ? (
                <span className="text-right text-sm text-zinc-500">{reason}</span>
              ) : (
                <select
                  aria-label={`Quantity for ${ticket.name}`}
                  value={quantities[ticket.id] ?? 0}
                  onChange={(event) =>
                    setQuantities((current) => ({
                      ...current,
                      [ticket.id]: Number(event.target.value),
                    }))
                  }
                  className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm"
                >
                  {Array.from({ length: maximum + 1 }, (_, quantity) => (
                    <option key={quantity} value={quantity}>
                      {quantity}
                    </option>
                  ))}
                </select>
              )}
            </li>
          );
        })}
      </ul>
      <div className="mt-5 flex flex-wrap items-center gap-4">
        <p className="font-medium">Total: {formatPrice(total)}</p>
        <button
          type="button"
          disabled={pending || selectedCount === 0 || selectedCount > 10}
          onClick={() => void continueToOrder()}
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          {pending
            ? 'Creating order…'
            : total === 0
              ? 'Register'
              : 'Continue to payment'}
        </button>
      </div>
      {selectedCount > 10 ? (
        <p role="alert" className="mt-3 text-sm text-red-700">
          At most 10 tickets per order
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-3 text-sm text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}
