'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ApiError, createEvent, type CreateEventInput } from '@/api';
import { useI18n } from '@/i18n/client';
import { errorText } from '@/i18n/errors';
import { clearSession, readToken, useSessionUser } from '@/session';
import { EventForm } from '../event-form';

const loginPath = '/login?next=/organizer/events/new';

export default function NewEventPage() {
  const router = useRouter();
  const { t } = useI18n();
  const user = useSessionUser();
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!readToken()) router.replace(loginPath);
  }, [router]);

  async function onCreate(input: CreateEventInput) {
    const token = readToken();
    if (!token || pending) return;
    setError(null);
    setPending(true);
    try {
      const { event } = await createEvent(token, input);
      router.replace(`/organizer/events/${event.id}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        clearSession();
        router.replace(loginPath);
      }
      setError(err);
      setPending(false);
    }
  }

  return (
    <div className="mx-auto max-w-lg">
      <Link href="/organizer/events" className="text-sm text-zinc-600 hover:underline">
        {t.events.backToEvents}
      </Link>
      <h1 className="mt-3 text-2xl font-semibold">{t.events.createTitle}</h1>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-red-700">
          {errorText(error, t)}
        </p>
      ) : null}
      {user?.role === 'organizer' ? (
        <EventForm pending={pending} onSave={onCreate} />
      ) : user ? (
        <Link href="/organizer/profile" className="mt-4 inline-block text-sm underline">
          {t.header.becomeOrganizer}
        </Link>
      ) : null}
    </div>
  );
}
