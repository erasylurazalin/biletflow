'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ApiError, formatWhen, listMyTickets, type Ticket } from '@/api';
import { clearSession, readToken } from '@/session';
import { TicketQr } from '@/ticket-qr';

function statusLabel(ticket: Ticket): string {
  return ticket.status === 'checked_in' ? 'Checked in' : ticket.status;
}

export default function TicketsPage() {
  const router = useRouter();
  const [tickets, setTickets] = useState<Ticket[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = readToken();
    if (!token) {
      router.replace('/login?next=/tickets');
      return;
    }

    let cancelled = false;
    listMyTickets(token)
      .then((next) => {
        if (cancelled) return;
        setTickets(next);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          clearSession();
          router.replace('/login?next=/tickets');
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
      <h1 className="text-2xl font-semibold">My tickets</h1>
      {error ? (
        <p role="alert" className="mt-6 rounded-md bg-red-50 p-3 text-sm text-red-700">
          {error}
        </p>
      ) : null}
      {tickets === null && error === null ? (
        <p className="mt-6 text-sm text-zinc-600">Loading tickets…</p>
      ) : null}
      {tickets?.length === 0 ? (
        <p className="mt-6 text-sm text-zinc-600">
          No tickets yet.{' '}
          <Link href="/" className="font-medium text-zinc-900 underline">
            Browse events
          </Link>
        </p>
      ) : null}
      {tickets && tickets.length > 0 ? (
        <ul className="mt-6 space-y-4">
          {tickets.map((ticket) => {
            const unavailable = ticket.status === 'cancelled' || ticket.status === 'refunded';
            return (
              <li
                key={ticket.id}
                className={`rounded-lg border border-zinc-200 bg-white p-5 ${unavailable ? 'opacity-60' : ''}`}
              >
                <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <Link
                      href={`/events/${ticket.event.id}`}
                      className="text-lg font-medium hover:underline"
                    >
                      {ticket.event.title}
                    </Link>
                    <p className="mt-1 text-sm text-zinc-600">
                      {formatWhen(ticket.event.starts_at)} · {ticket.event.venue_name}
                    </p>
                    <p className="mt-4 text-sm font-medium">{ticket.ticket_type_name}</p>
                    <p className="mt-1 text-sm text-zinc-600">{ticket.attendee_name}</p>
                    <p className="mt-3 font-mono text-sm">{ticket.code}</p>
                    <p className="mt-2 text-sm text-zinc-600">Status: {statusLabel(ticket)}</p>
                  </div>
                  {ticket.status === 'valid' ? (
                    <div className="shrink-0 self-center sm:self-start">
                      <TicketQr payload={ticket.qr_payload} />
                    </div>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
