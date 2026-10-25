'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { ApiError, formatPrice, formatWhen, getOrder, payOrder, type Order } from '@/api';
import { useI18n } from '@/i18n/client';
import { errorText } from '@/i18n/errors';
import { fill } from '@/i18n/format';
import { clearSession, readToken } from '@/session';

const buttonClass =
  'rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60';

function Checkout() {
  const { id: orderId } = useParams<{ id: string }>();
  const router = useRouter();
  const { locale, t } = useI18n();
  const [order, setOrder] = useState<Order | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [expired, setExpired] = useState(false);
  const [pending, setPending] = useState(false);
  const loginPath = `/login?next=${encodeURIComponent(`/orders/${orderId}`)}`;

  useEffect(() => {
    const token = readToken();
    if (!token) {
      router.replace(loginPath);
      return;
    }

    let cancelled = false;
    getOrder(token, orderId)
      .then((next) => {
        if (cancelled) return;
        setOrder(next);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          clearSession();
          router.replace(loginPath);
        } else if (err instanceof ApiError && err.status === 404) {
          setNotFound(true);
        } else {
          setError(errorText(err, t));
        }
      });

    return () => {
      cancelled = true;
    };
    // t only changes with the language, and refetching the order then is harmless.
  }, [loginPath, orderId, router, t]);

  async function pay(simulateFailure = false) {
    if (pending) return;
    const token = readToken();
    if (!token) {
      router.replace(loginPath);
      return;
    }

    setError(null);
    setExpired(false);
    setPending(true);
    try {
      setOrder(await payOrder(token, orderId, simulateFailure));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        clearSession();
        router.replace(loginPath);
        return;
      }
      if (err instanceof ApiError && err.code === 'ORDER_EXPIRED') {
        setExpired(true);
      } else {
        setError(errorText(err, t));
      }
    } finally {
      setPending(false);
    }
  }

  if (notFound) {
    return <h1 className="text-2xl font-semibold">{t.checkout.notFound}</h1>;
  }

  if (!order) {
    return (
      <div className="mx-auto max-w-2xl">
        {error ? (
          <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-700">
            {error}
          </p>
        ) : (
          <p className="text-sm text-zinc-600">{t.checkout.loading}</p>
        )}
      </div>
    );
  }

  const eventLink = `/events/${order.event.id}`;

  return (
    <div className="mx-auto max-w-2xl">
      <Link href={eventLink} className="text-sm text-zinc-500 hover:text-zinc-800">
        {t.checkout.back}
      </Link>
      <h1 className="mt-4 text-2xl font-semibold">{order.event.title}</h1>

      <ul className="mt-6 divide-y divide-zinc-200 rounded-lg border border-zinc-200 bg-white px-5">
        {order.items.map((item) => (
          <li key={item.ticket_type_id} className="flex items-center justify-between gap-4 py-4">
            <div>
              <p className="font-medium">{item.name}</p>
              <p className="text-sm text-zinc-600">
                {fill(t.checkout.quantity, { count: item.quantity })}
              </p>
            </div>
            <p className="text-sm text-zinc-700">
              {fill(t.checkout.each, { price: formatPrice(item.unit_price, locale) })}
            </p>
          </li>
        ))}
      </ul>
      <div className="mt-4 space-y-1 text-sm">
        <p>{fill(t.checkout.tickets, { amount: formatPrice(order.subtotal, locale) })}</p>
        {order.discount > 0 ? (
          <p>
            {fill(t.checkout.discount, {
              code: order.promo?.code ?? t.checkout.discountNoCode,
              amount: formatPrice(order.discount, locale),
            })}
          </p>
        ) : null}
        {order.processing_fee > 0 ? (
          <p>
            {fill(t.checkout.processingCharge, {
              amount: formatPrice(order.processing_fee, locale),
            })}
          </p>
        ) : null}
        <p className="pt-1 text-lg font-semibold">
          {fill(t.common.total, { amount: formatPrice(order.total, locale) })}
        </p>
      </div>

      {error ? (
        <p role="alert" className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      {order.status === 'pending' && !expired ? (
        <section className="mt-6">
          {order.expires_at ? (
            <p className="text-sm text-zinc-600">
              {fill(t.checkout.reservedUntil, { when: formatWhen(order.expires_at, locale) })}
            </p>
          ) : null}
          {order.total > 0 ? (
            <p className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
              {t.checkout.demoNotice}
            </p>
          ) : null}
          <button
            type="button"
            disabled={pending}
            onClick={() => void pay()}
            className={`${buttonClass} mt-4`}
          >
            {pending
              ? t.checkout.processing
              : order.total === 0
                ? t.checkout.confirm
                : fill(t.checkout.pay, { amount: formatPrice(order.total, locale) })}
          </button>
          {order.total > 0 ? (
            <button
              type="button"
              disabled={pending}
              onClick={() => void pay(true)}
              className="mt-2 block rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-600 disabled:opacity-60"
            >
              {t.checkout.simulateFailure}
            </button>
          ) : null}
        </section>
      ) : null}

      {expired ? (
        <section className="mt-6 rounded-md bg-red-50 p-4 text-sm text-red-700">
          <p>{t.checkout.expired}</p>
          <Link href={eventLink} className="mt-2 inline-block underline">
            {t.checkout.backToEvent}
          </Link>
        </section>
      ) : null}

      {order.status === 'paid' ? (
        <section className="mt-8">
          <h2 className="text-2xl font-semibold">{t.checkout.success}</h2>
          {order.payment ? (
            <p className="mt-3 text-sm text-zinc-600">
              {fill(t.checkout.simulatedPayment, {
                amount: formatPrice(order.payment.amount, locale),
                when: formatWhen(order.payment.paid_at, locale),
              })}
            </p>
          ) : null}
          <ul className="mt-5 space-y-3">
            {order.tickets.map((ticket) => (
              <li key={ticket.id} className="rounded-lg border border-zinc-200 bg-white p-4">
                <p className="font-medium">{ticket.code}</p>
                <p className="mt-1 text-sm text-zinc-700">{ticket.ticket_type_name}</p>
                <p className="text-sm text-zinc-600">{ticket.attendee_name}</p>
                <p className="mt-1 text-sm text-zinc-500">
                  {fill(t.common.status, { status: t.ticketStatus[ticket.status] })}
                </p>
              </li>
            ))}
          </ul>
          <Link href="/tickets" className="mt-5 inline-block text-sm font-medium underline">
            {t.tickets.title}
          </Link>
        </section>
      ) : null}

      {order.status === 'cancelled' || order.status === 'refunded' ? (
        <section className="mt-6">
          <p className="text-zinc-700">
            {order.status === 'cancelled' ? t.checkout.cancelled : t.checkout.refunded}
          </p>
          {order.status === 'refunded' && order.refund ? (
            <p className="mt-2 text-sm text-zinc-600">
              {fill(t.checkout.refundedOn, {
                amount: formatPrice(order.refund.amount, locale),
                when: formatWhen(order.refund.refunded_at, locale),
              })}
            </p>
          ) : null}
          <Link href={eventLink} className="mt-3 inline-block text-sm font-medium underline">
            {t.checkout.backToEvent}
          </Link>
        </section>
      ) : null}
    </div>
  );
}

export default function OrderPage() {
  const { t } = useI18n();
  return (
    <Suspense fallback={<p className="text-sm text-zinc-600">{t.checkout.loading}</p>}>
      <Checkout />
    </Suspense>
  );
}
