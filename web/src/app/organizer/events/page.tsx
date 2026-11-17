'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ApiError, formatWhen, listMyEvents, type MyEventsResponse } from '@/api';
import { useI18n } from '@/i18n/client';
import { errorText } from '@/i18n/errors';
import { clearSession, readToken, useSessionUser } from '@/session';
import { buttonClass } from './event-form';

export default function MyEventsPage() {
  const { t } = useI18n();
  const user = useSessionUser();
  const [offset, setOffset] = useState(0);

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-semibold">{t.organizerEvents.title}</h1>
      <p className="mt-2 text-sm text-zinc-600">{t.organizerEvents.intro}</p>
      {user?.role === 'organizer' ? (
        <Link href="/organizer/events/new" className={`mt-4 inline-block ${buttonClass}`}>
          {t.organizerEvents.createEvent}
        </Link>
      ) : user ? (
        <Link href="/organizer/profile" className={`mt-4 inline-block ${buttonClass}`}>
          {t.header.becomeOrganizer}
        </Link>
      ) : null}
      <EventList key={offset} offset={offset} setOffset={setOffset} />
    </div>
  );
}

function EventList({ offset, setOffset }: { offset: number; setOffset: (offset: number) => void }) {
  const router = useRouter();
  const { locale, t } = useI18n();
  const [page, setPage] = useState<MyEventsResponse | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    const token = readToken();
    if (!token) {
      router.replace('/login?next=/organizer/events');
      return;
    }
    let active = true;
    listMyEvents(token, offset)
      .then((result) => {
        if (active && readToken() === token) setPage(result);
      })
      .catch((err: unknown) => {
        if (!active || readToken() !== token) return;
        if (err instanceof ApiError && err.status === 401) {
          clearSession();
          router.replace('/login?next=/organizer/events');
          return;
        }
        setError(err);
      });
    return () => {
      active = false;
    };
  }, [offset, router]);

  if (error)
    return (
      <p role="alert" className="mt-6 text-sm text-red-700">
        {errorText(error, t)}
      </p>
    );
  if (!page)
    return (
      <p role="status" className="mt-6 text-sm text-zinc-600">
        {t.common.loading}
      </p>
    );

  return (
    <>
      {page.events.length === 0 ? (
        <p className="mt-6 text-sm text-zinc-600">
          {offset === 0 ? t.organizerEvents.empty : t.organizerEvents.noMoreEvents}
        </p>
      ) : (
        <ul className="mt-6 divide-y divide-zinc-200 rounded-lg border border-zinc-200 bg-white">
          {page.events.map((event) => (
            <li key={event.id} className="flex flex-wrap justify-between gap-4 px-5 py-4">
              <div>
                <Link
                  href={`/organizer/events/${event.id}`}
                  className="text-lg font-medium hover:underline"
                >
                  {event.title}
                </Link>
                <p className="mt-1 text-sm text-zinc-600">
                  {event.venue_name} · {event.venue_address}
                </p>
                <p className="mt-1 text-sm text-zinc-500">
                  {formatWhen(event.starts_at, locale)} — {formatWhen(event.ends_at, locale)}
                </p>
                <p className="mt-2 text-sm text-zinc-600">{t.organizerEvents[event.status]}</p>
              </div>
              <div className="text-sm text-zinc-600">
                <p>
                  {t.organizerEvents.capacity}: {event.capacity}
                </p>
                <p>
                  {t.organizerEvents.ticketsSold}: {event.tickets_sold}
                </p>
                <p>
                  {t.organizerEvents.checkedIn}: {event.checked_in}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
      {offset > 0 || page.events.length === page.limit ? (
        <div className="mt-4 flex gap-3">
          <button
            type="button"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - page.limit))}
            className={buttonClass}
          >
            {t.organizerEvents.previousPage}
          </button>
          <button
            type="button"
            disabled={page.events.length < page.limit}
            onClick={() => setOffset(offset + page.limit)}
            className={buttonClass}
          >
            {t.organizerEvents.nextPage}
          </button>
        </div>
      ) : null}
    </>
  );
}
