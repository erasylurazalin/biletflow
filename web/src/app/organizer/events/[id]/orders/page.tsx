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
import { useI18n } from '@/i18n/client';
import { errorText } from '@/i18n/errors';
import { fill, plural } from '@/i18n/format';
import { clearSession, readToken } from '@/session';

const buttonClass =
  'rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-60';

function EventOrders() {
  const { id: eventId } = useParams<{ id: string }>();
  const router = useRouter();
  const { locale, t } = useI18n();
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
        setError(t.organizerOrders.ownerOnly);
        return;
      }
      setError(errorText(err, t));
    },
    [loginPath, router, t],
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
        {t.organizer.back}
      </Link>
      <h1 className="mt-4 text-2xl font-semibold">{t.organizerOrders.title}</h1>
      <p className="mt-2 text-sm text-zinc-600">
        {t.organizerOrders.intro}
      </p>

      {error ? (
        <p role="alert" className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      {loading ? <p className="mt-6 text-sm text-zinc-600">{t.organizerOrders.loading}</p> : null}
      {!loading && !orders && error ? (
        <button
          type="button"
          disabled={pending !== null}
          onClick={() => void refresh()}
          className={`${buttonClass} mt-4`}
        >
          {pending === 'refresh' ? t.common.loading : t.organizer.tryAgain}
        </button>
      ) : null}

      {orders ? (
        <ul className="mt-6 divide-y divide-zinc-200 rounded-lg border border-zinc-200 bg-white px-5">
          {orders.length === 0 ? (
            <li className="py-4 text-sm text-zinc-600">{t.organizerOrders.empty}</li>
          ) : null}
          {orders.map((order) => (
            <li key={order.id} className="py-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-zinc-900">{order.buyer.name}</p>
                  <p className="text-sm text-zinc-600">{order.buyer.email}</p>
                  <p className="mt-1 text-sm text-zinc-600">
                    {plural(locale, t.organizer.ticketCount, order.ticket_count)}
                    {order.checked_in_count > 0
                      ? fill(t.organizerOrders.checkedIn, { count: order.checked_in_count })
                      : ''}
                    {' · '}
                    {formatWhen(order.created_at, locale)}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-sm font-medium text-zinc-900">
                    {formatPrice(order.total, locale)}
                  </p>
                  <p className="text-sm text-zinc-600">{t.orderStatus[order.status]}</p>
                </div>
              </div>

              {order.status === 'refunded' && order.refund ? (
                <p className="mt-2 text-sm text-zinc-600">
                  {fill(t.organizerOrders.refundedOn, {
                    amount: formatPrice(order.refund.amount, locale),
                    when: formatWhen(order.refund.refunded_at, locale),
                  })}
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
                          fill(t.organizerOrders.confirmRefund, {
                            amount: formatPrice(order.total, locale),
                            name: order.buyer.name,
                          }),
                          (token) => refundOrder(eventId, order.id, token),
                        )
                      }
                      className={buttonClass}
                    >
                      {pending === `refund:${order.id}`
                        ? t.organizerOrders.refunding
                        : t.organizerOrders.refund}
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={pending !== null}
                      onClick={() =>
                        void perform(
                          `cancel:${order.id}`,
                          fill(t.organizerOrders.confirmCancel, {
                            name: order.buyer.name,
                            tickets: plural(locale, t.organizer.ticketCount, order.ticket_count),
                          }),
                          (token) => cancelRegistration(eventId, order.id, token),
                        )
                      }
                      className={buttonClass}
                    >
                      {pending === `cancel:${order.id}`
                        ? t.organizerOrders.cancelling
                        : t.organizerOrders.cancel}
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
  const { t } = useI18n();
  return (
    <Suspense fallback={<p className="text-sm text-zinc-600">{t.organizerOrders.loading}</p>}>
      <EventOrders />
    </Suspense>
  );
}
