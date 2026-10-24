'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { ApiError, formatPrice, formatWhen, getOrder, payOrder, type Order } from '@/api';
import { clearSession, readToken } from '@/session';

const buttonClass =
  'rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60';

function Checkout() {
  const { id: orderId } = useParams<{ id: string }>();
  const router = useRouter();
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
          setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
        }
      });

    return () => {
      cancelled = true;
    };
  }, [loginPath, orderId, router]);

  async function pay() {
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
      setOrder(await payOrder(token, orderId));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        clearSession();
        router.replace(loginPath);
        return;
      }
      if (err instanceof ApiError && err.code === 'ORDER_EXPIRED') {
        setExpired(true);
      } else {
        setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
      }
    } finally {
      setPending(false);
    }
  }

  if (notFound) {
    return <h1 className="text-2xl font-semibold">Order not found</h1>;
  }

  if (!order) {
    return (
      <div className="mx-auto max-w-2xl">
        {error ? (
          <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-700">
            {error}
          </p>
        ) : (
          <p className="text-sm text-zinc-600">Loading order…</p>
        )}
      </div>
    );
  }

  const eventLink = `/events/${order.event.id}`;

  return (
    <div className="mx-auto max-w-2xl">
      <Link href={eventLink} className="text-sm text-zinc-500 hover:text-zinc-800">
        ← Event
      </Link>
      <h1 className="mt-4 text-2xl font-semibold">{order.event.title}</h1>

      <ul className="mt-6 divide-y divide-zinc-200 rounded-lg border border-zinc-200 bg-white px-5">
        {order.items.map((item) => (
          <li key={item.ticket_type_id} className="flex items-center justify-between gap-4 py-4">
            <div>
              <p className="font-medium">{item.name}</p>
              <p className="text-sm text-zinc-600">Quantity: {item.quantity}</p>
            </div>
            <p className="text-sm text-zinc-700">{formatPrice(item.unit_price)} each</p>
          </li>
        ))}
      </ul>
      <p className="mt-4 text-lg font-semibold">Total: {formatPrice(order.total)}</p>

      {error ? (
        <p role="alert" className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      {order.status === 'pending' && !expired ? (
        <section className="mt-6">
          {order.expires_at ? (
            <p className="text-sm text-zinc-600">Reserved until {formatWhen(order.expires_at)}</p>
          ) : null}
          {order.total > 0 ? (
            <p className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
              Demonstration payment. No real money is charged and no card details are needed.
            </p>
          ) : null}
          <button
            type="button"
            disabled={pending}
            onClick={() => void pay()}
            className={`${buttonClass} mt-4`}
          >
            {pending
              ? 'Processing…'
              : order.total === 0
                ? 'Confirm registration'
                : `Pay ${formatPrice(order.total)} (simulated)`}
          </button>
        </section>
      ) : null}

      {expired ? (
        <section className="mt-6 rounded-md bg-red-50 p-4 text-sm text-red-700">
          <p>This reservation expired. Go back to the event to try again.</p>
          <Link href={eventLink} className="mt-2 inline-block underline">
            Back to the event
          </Link>
        </section>
      ) : null}

      {order.status === 'paid' ? (
        <section className="mt-8">
          <h2 className="text-2xl font-semibold">You&apos;re in.</h2>
          {order.payment ? (
            <p className="mt-3 text-sm text-zinc-600">
              Simulated payment of {formatPrice(order.payment.amount)} ·{' '}
              {formatWhen(order.payment.paid_at)}
            </p>
          ) : null}
          <ul className="mt-5 space-y-3">
            {order.tickets.map((ticket) => (
              <li key={ticket.id} className="rounded-lg border border-zinc-200 bg-white p-4">
                <p className="font-medium">{ticket.code}</p>
                <p className="mt-1 text-sm text-zinc-700">{ticket.ticket_type_name}</p>
                <p className="text-sm text-zinc-600">{ticket.attendee_name}</p>
                <p className="mt-1 text-sm text-zinc-500">Status: {ticket.status}</p>
              </li>
            ))}
          </ul>
          <Link href="/tickets" className="mt-5 inline-block text-sm font-medium underline">
            My tickets
          </Link>
        </section>
      ) : null}

      {order.status === 'cancelled' || order.status === 'refunded' ? (
        <section className="mt-6">
          <p className="text-zinc-700">
            This order was {order.status === 'cancelled' ? 'cancelled' : 'refunded'}.
          </p>
          <Link href={eventLink} className="mt-3 inline-block text-sm font-medium underline">
            Back to the event
          </Link>
        </section>
      ) : null}
    </div>
  );
}

export default function OrderPage() {
  return (
    <Suspense fallback={<p className="text-sm text-zinc-600">Loading order…</p>}>
      <Checkout />
    </Suspense>
  );
}
