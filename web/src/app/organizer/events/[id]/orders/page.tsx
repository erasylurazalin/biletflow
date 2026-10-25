'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  cancelRegistration,
  formatPrice,
  formatWhen,
  listEventOrders,
  refundOrder,
  type OrganizerOrder,
} from '@/api';
import { clearSession, readToken } from '@/session';

const buttonClass =
  'rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-60';

function EventOrders() {
  const { id: eventId } = useParams<{ id: string }>();
  const router = useRouter();
  const [orders, setOrders] = useState<OrganizerOrder[] | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loading = orders === null && error === null;
  const loginPath = `/login?next=${encodeURIComponent(`/organizer/events/${eventId}/orders`)}`;

  const showError = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) {
        clearSession();
        router.replace(loginPath);
        return;
      }
      if (err instanceof ApiError && err.status === 403) {
        setError("Only the event's organizer can see its orders");
        return;
      }
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
    },
    [loginPath, router],
  );

  const refresh = useCallback(async () => {
    const token = readToken();
    if (!token) {
      router.replace(loginPath);
      return;
    }
    setPending('refresh');
    try {
      setOrders(await listEventOrders(eventId, token));
      setError(null);
    } catch (err) {
      showError(err);
    } finally {
      setPending(null);
    }
  }, [eventId, loginPath, router, showError]);

  useEffect(() => {
    const token = readToken();
    if (!token) {
      router.replace(loginPath);
      return;
    }
    let cancelled = false;
    listEventOrders(eventId, token)
      .then((next) => {
        if (cancelled) return;
        setOrders(next);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) showError(err);
      });
    return () => {
      cancelled = true;
    };
  }, [eventId, loginPath, router, showError]);

  // Both actions are final, so they ask once before talking to the API. The API's own
  // rules still decide: a checked-in ticket comes back here as the 409 message.
  async function perform(
    step: string,
    ask: string,
    action: (token: string) => Promise<unknown>,
  ): Promise<void> {
    if (!window.confirm(ask)) return;
    const token = readToken();
    if (!token) {
      router.replace(loginPath);
      return;
    }
    setError(null);
    setPending(step);
    try {
      await action(token);
      await refresh();
    } catch (err) {
      showError(err);
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="mx-auto max-w-2xl">
      <Link href={`/events/${eventId}`} className="text-sm text-zinc-500 hover:text-zinc-800">
        ← Event
      </Link>
      <h1 className="mt-4 text-2xl font-semibold">Orders</h1>
      <p className="mt-2 text-sm text-zinc-600">
        Every order for this event. Refunds are full and simulated: no real money moves.
      </p>

      {error ? (
        <p role="alert" className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      {loading ? <p className="mt-6 text-sm text-zinc-600">Loading orders…</p> : null}
      {!loading && !orders && error ? (
        <button
          type="button"
          disabled={pending !== null}
          onClick={() => void refresh()}
          className={`${buttonClass} mt-4`}
        >
          {pending === 'refresh' ? 'Loading…' : 'Try again'}
        </button>
      ) : null}

      {orders ? (
        <ul className="mt-6 divide-y divide-zinc-200 rounded-lg border border-zinc-200 bg-white px-5">
          {orders.length === 0 ? (
            <li className="py-4 text-sm text-zinc-600">Nobody has ordered yet.</li>
          ) : null}
          {orders.map((order) => (
            <li key={order.id} className="py-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-zinc-900">{order.buyer.name}</p>
                  <p className="text-sm text-zinc-600">{order.buyer.email}</p>
                  <p className="mt-1 text-sm text-zinc-600">
                    {order.ticket_count}{' '}
                    {order.ticket_count === 1 ? 'ticket' : 'tickets'}
                    {order.checked_in_count > 0 ? `, ${order.checked_in_count} checked in` : ''}
                    {' · '}
                    {formatWhen(order.created_at)}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-sm font-medium text-zinc-900">{formatPrice(order.total)}</p>
                  <p className="text-sm text-zinc-600">{order.status}</p>
                </div>
              </div>

              {order.status === 'refunded' && order.refund ? (
                <p className="mt-2 text-sm text-zinc-600">
                  Refunded {formatPrice(order.refund.amount)} (simulated) on{' '}
                  {formatWhen(order.refund.refunded_at)}
                </p>
              ) : null}

              {order.status === 'paid' ? (
                <div className="mt-3">
                  {order.total > 0 ? (
                    <button
                      type="button"
                      disabled={pending !== null}
                      onClick={() =>
                        void perform(
                          `refund:${order.id}`,
                          `Refund ${formatPrice(order.total)} for ${order.buyer.name}'s order (simulated, full refund)?`,
                          (token) => refundOrder(eventId, order.id, token),
                        )
                      }
                      className={buttonClass}
                    >
                      {pending === `refund:${order.id}` ? 'Refunding…' : 'Refund'}
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={pending !== null}
                      onClick={() =>
                        void perform(
                          `cancel:${order.id}`,
                          `Cancel ${order.buyer.name}'s free registration (${order.ticket_count} tickets)?`,
                          (token) => cancelRegistration(eventId, order.id, token),
                        )
                      }
                      className={buttonClass}
                    >
                      {pending === `cancel:${order.id}` ? 'Cancelling…' : 'Cancel registration'}
                    </button>
                  )}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export default function EventOrdersPage() {
  return (
    <Suspense fallback={<p className="text-sm text-zinc-600">Loading orders…</p>}>
      <EventOrders />
    </Suspense>
  );
}
