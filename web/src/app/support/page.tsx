'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  ApiError,
  formatWhen,
  listSupportCases,
  type SupportCase,
  type SupportStatus,
} from '@/api';
import { useI18n } from '@/i18n/client';
import { errorText } from '@/i18n/errors';
import { fill } from '@/i18n/format';
import { clearSession, readToken, useSessionUser } from '@/session';

const statusStyles: Record<SupportStatus, string> = {
  open: 'bg-amber-50 text-amber-900 ring-amber-200',
  in_progress: 'bg-blue-50 text-blue-900 ring-blue-200',
  waiting_for_customer: 'bg-violet-50 text-violet-900 ring-violet-200',
  resolved: 'bg-emerald-50 text-emerald-900 ring-emerald-200',
};

const statuses: SupportStatus[] = ['open', 'in_progress', 'waiting_for_customer', 'resolved'];

export default function SupportPage() {
  const router = useRouter();
  const { locale, t } = useI18n();
  const user = useSessionUser();
  const [cases, setCases] = useState<SupportCase[] | null>(null);
  const [status, setStatus] = useState<SupportStatus | ''>('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = readToken();
    if (!token) {
      router.replace('/login?next=/support');
      return;
    }

    let cancelled = false;
    listSupportCases(token, status || undefined)
      .then((next) => {
        if (cancelled) return;
        setCases(next);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          clearSession();
          router.replace('/login?next=/support');
        } else {
          setError(errorText(err, t));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [router, status, t]);

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{t.support.title}</h1>
          <p className="mt-1 text-sm text-zinc-600">{t.support.intro}</p>
        </div>
        {user?.role === 'organizer' ? (
          <Link
            href="/support/new?kind=platform"
            className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white"
          >
            {t.support.newCase}
          </Link>
        ) : null}
      </div>

      <label className="mt-5 flex items-center gap-2 text-sm text-zinc-700">
        {t.support.filter}
        <select
          value={status}
          onChange={(event) => setStatus(event.target.value as SupportStatus | '')}
          className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm"
        >
          <option value="">{t.support.allStatuses}</option>
          {statuses.map((value) => (
            <option key={value} value={value}>
              {t.support.status[value]}
            </option>
          ))}
        </select>
      </label>

      {error ? (
        <p role="alert" className="mt-5 rounded-md bg-red-50 p-3 text-sm text-red-700">
          {error}
        </p>
      ) : null}
      {cases === null && error === null ? (
        <p className="mt-6 text-sm text-zinc-600">{t.support.loading}</p>
      ) : null}
      {cases?.length === 0 ? <p className="mt-6 text-sm text-zinc-600">{t.support.empty}</p> : null}

      {cases && cases.length > 0 ? (
        <ul className="mt-6 space-y-3">
          {cases.map((item) => (
            <li key={item.id}>
              <Link
                href={`/support/${item.id}`}
                className="block rounded-lg border border-zinc-200 bg-white p-5 hover:border-zinc-400"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-medium">{item.subject}</p>
                    <p className="mt-1 text-sm text-zinc-600">
                      {item.event_title ?? t.support.noEvent}
                    </p>
                  </div>
                  <span
                    className={`rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${statusStyles[item.status]}`}
                  >
                    {t.support.status[item.status]}
                  </span>
                </div>
                <p className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-zinc-500">
                  <span>
                    {item.role === 'opener' ? t.support.roleOpener : t.support.roleResponder}
                  </span>
                  <span>{fill(t.support.listOpenedBy, { name: item.opened_by_name })}</span>
                  <span>
                    {fill(t.support.lastActivity, {
                      when: formatWhen(item.last_message_at, locale),
                    })}
                  </span>
                </p>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
