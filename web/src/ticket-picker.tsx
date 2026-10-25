'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  ApiError,
  createOrder,
  formatPrice,
  formatWhen,
  type PromoInfo,
  type TicketType,
} from '@/api';
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
  promo,
}: {
  eventId: string;
  ticketTypes: TicketType[];
  paidSalesActive: boolean;
  promo?: PromoInfo | null;
}) {
  const router = useRouter();
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [attendeeNames, setAttendeeNames] = useState<Record<string, string[]>>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [promoCode, setPromoCode] = useState(promo?.code ?? '');
  const [promoError, setPromoError] = useState<string | null>(null);

  // The hidden types the code covers become orderable here: the public event detail
  // leaves them out, so the promo response is where they come from.
  const hiddenCovered: TicketType[] = (promo?.ticket_types ?? [])
    .filter((type) => !ticketTypes.some((visible) => visible.id === type.id))
    .map((type) => ({
      id: type.id,
      name: type.name,
      price: type.price,
      currency: 'KZT',
      quantity_total: type.quantity_available,
      quantity_available: type.quantity_available,
      sales_start_at: null,
      sales_end_at: null,
      is_hidden: true,
    }));
  const orderable = [...ticketTypes, ...hiddenCovered];

  const selectedCount = orderable.reduce((sum, ticket) => sum + (quantities[ticket.id] ?? 0), 0);
  const total = orderable.reduce(
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

    const items = orderable.flatMap((ticket) => {
      const quantity = quantities[ticket.id] ?? 0;
      const savedNames = attendeeNames[ticket.id] ?? [];
      const names = Array.from(
        { length: quantity },
        (_, index) => savedNames[index]?.trim() ?? '',
      );
      const allNamed = names.every((name) => name.length > 0);
      return quantity > 0
        ? [
            {
              ticket_type_id: ticket.id,
              quantity,
              ...(allNamed && { attendee_names: names }),
            },
          ]
        : [];
    });
    const code = promoCode.trim();

    setError(null);
    setPromoError(null);
    setPending(true);
    try {
      const order = await createOrder(token, eventId, items, code || undefined);
      router.push(`/orders/${order.id}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        clearSession();
        router.replace(loginPath);
        return;
      }
      if (err instanceof ApiError && err.code === 'PROMO_CODE_INVALID') {
        setPromoError(err.message);
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
        {orderable.map((ticket) => {
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
      {selectedCount >= 1 && selectedCount <= 10 ? (
        <div className="mt-5 space-y-3">
          {orderable.flatMap((ticket) =>
            Array.from({ length: quantities[ticket.id] ?? 0 }, (_, index) => (
              <label key={`${ticket.id}-${index}`} className="block text-sm">
                <span className="mb-1 block font-medium">
                  {ticket.name}, ticket {index + 1}: attendee name
                </span>
                <input
                  type="text"
                  maxLength={100}
                  placeholder="Your name"
                  value={attendeeNames[ticket.id]?.[index] ?? ''}
                  onChange={(event) =>
                    setAttendeeNames((current) => {
                      const names = [...(current[ticket.id] ?? [])];
                      names[index] = event.target.value;
                      return { ...current, [ticket.id]: names };
                    })
                  }
                  className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2"
                />
              </label>
            )),
          )}
        </div>
      ) : null}
      <div className="mt-5 max-w-sm">
        <label htmlFor="promo-code" className="mb-1 block text-sm font-medium">
          Promo code
        </label>
        <input
          id="promo-code"
          type="text"
          maxLength={30}
          placeholder="Enter a promo code"
          value={promoCode}
          onChange={(event) => {
            setPromoCode(event.target.value);
            setPromoError(null);
          }}
          className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm uppercase"
        />
        {promo ? (
          <p className="mt-1 text-sm text-zinc-600">
            Code {promo.code} applied:{' '}
            {promo.discount_type === 'percent'
              ? `${promo.discount_value}%`
              : formatPrice(promo.discount_value)}{' '}
            off{' '}
            {promo.ticket_type_ids === null
              ? 'all tickets'
              : promo.ticket_types.map((type) => type.name).join(', ')}
          </p>
        ) : null}
        {promoError ? (
          <p role="alert" className="mt-1 text-sm text-red-700">
            {promoError}
          </p>
        ) : null}
      </div>
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
