'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ApiError, formatPrice, formatWhen, listMyOrders, type OrderListItem } from '@/api';
import { clearSession, readToken } from '@/session';

export default function OrdersPage() {
  const router = useRouter();
  const [orders, setOrders] = useState<OrderListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = readToken();
    if (!token) {
      router.replace('/login?next=/orders');
      return;
    }

    let cancelled = false;
    listMyOrders(token)
      .then((next) => {
        if (cancelled) return;
        setOrders(next);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          clearSession();
          router.replace('/login?next=/orders');
        } else {
          setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
        }
      });

    return () => {
      cancelled = true;
    };
  }, [router]);

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-semibold">My orders</h1>
      {error ? (
        <p role="alert" className="mt-6 rounded-md bg-red-50 p-3 text-sm text-red-700">
          {error}
        </p>
      ) : null}
      {orders === null && error === null ? (
        <p className="mt-6 text-sm text-zinc-600">Loading orders…</p>
      ) : null}
      {orders?.length === 0 ? <p className="mt-6 text-sm text-zinc-600">No orders yet.</p> : null}
      {orders && orders.length > 0 ? (
        <ul className="mt-6 divide-y divide-zinc-200 rounded-lg border border-zinc-200 bg-white px-5">
          {orders.map((order) => (
            <li key={order.id} className="flex items-center justify-between gap-4 py-4">
              <div>
                <h2 className="font-medium">{order.event.title}</h2>
                <p className="mt-1 text-sm text-zinc-600">{formatWhen(order.created_at)}</p>
                <p className="mt-2 text-sm text-zinc-700">Total: {formatPrice(order.total)}</p>
                <p className="mt-1 text-sm text-zinc-600">Status: {order.status}</p>
              </div>
              <Link href={`/orders/${order.id}`} className="text-sm font-medium underline">
                View
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
