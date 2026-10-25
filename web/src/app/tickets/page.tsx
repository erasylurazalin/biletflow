'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  ApiError,
  downloadTicketPdf,
  formatWhen,
  listMyTickets,
  type Ticket,
} from '@/api';
import { useI18n } from '@/i18n/client';
import { errorText } from '@/i18n/errors';
import { fill } from '@/i18n/format';
import { clearSession, readToken } from '@/session';
import { TicketQr } from '@/ticket-qr';

export default function TicketsPage() {
  const router = useRouter();
  const { locale, t } = useI18n();
  const [tickets, setTickets] = useState<Ticket[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The ticket whose PDF is being fetched, so only its button says "Preparing…".
  const [pending, setPending] = useState<string | null>(null);

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
          setError(errorText(err, t));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [router, t]);

  // Fetched with the token, then handed to the browser as a download: the PDF is a
  // server-rendered document, never a link the browser opens on its own.
  async function downloadPdf(ticket: Ticket): Promise<void> {
    const token = readToken();
    if (!token) {
      router.replace('/login?next=/tickets');
      return;
    }

    setPending(ticket.id);
    setError(null);
    try {
      const blob = await downloadTicketPdf(ticket.id, token);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `biletflow-${ticket.code}.pdf`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 401) {
        clearSession();
        router.replace('/login?next=/tickets');
        return;
      }
      setError(err instanceof ApiError ? errorText(err, t) : t.tickets.pdfError);
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-semibold">{t.tickets.title}</h1>
      {error ? (
        <p role="alert" className="mt-6 rounded-md bg-red-50 p-3 text-sm text-red-700">
          {error}
        </p>
      ) : null}
      {tickets === null && error === null ? (
        <p className="mt-6 text-sm text-zinc-600">{t.tickets.loading}</p>
      ) : null}
      {tickets?.length === 0 ? (
        <p className="mt-6 text-sm text-zinc-600">
          {t.tickets.empty}{' '}
          <Link href="/" className="font-medium text-zinc-900 underline">
            {t.tickets.browse}
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
                      {formatWhen(ticket.event.starts_at, locale)} · {ticket.event.venue_name}
                    </p>
                    <p className="mt-4 text-sm font-medium">{ticket.ticket_type_name}</p>
                    <p className="mt-1 text-sm text-zinc-600">{ticket.attendee_name}</p>
                    <p className="mt-3 font-mono text-sm">{ticket.code}</p>
                    <p className="mt-2 text-sm text-zinc-600">
                      {fill(t.common.status, { status: t.ticketStatus[ticket.status] })}
                    </p>
                  </div>
                  <div className="shrink-0 space-y-3 self-center sm:self-start">
                    {ticket.status === 'valid' ? <TicketQr payload={ticket.qr_payload} /> : null}
                    {/* Every status downloads: the PDF says the status itself. */}
                    <button
                      type="button"
                      onClick={() => void downloadPdf(ticket)}
                      disabled={pending === ticket.id}
                      className="w-[240px] rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-medium hover:bg-zinc-50 disabled:opacity-60"
                    >
                      {pending === ticket.id ? t.tickets.preparing : t.tickets.downloadPdf}
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
