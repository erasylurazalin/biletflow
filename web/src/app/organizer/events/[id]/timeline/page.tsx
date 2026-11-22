'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import {
  ApiError,
  formatWhen,
  getEventTimeline,
  type EventTimelineResponse,
  type TimelineFilters,
} from '@/api';
import { useI18n } from '@/i18n/client';
import { errorText } from '@/i18n/errors';
import { clearSession, readToken } from '@/session';
import { buttonClass, fieldClass } from '../../event-form';

const textButtonClass = 'text-sm text-zinc-600 hover:underline disabled:opacity-60';

export default function EventTimelinePage() {
  const { id } = useParams<{ id: string }>();
  return <TimelineLoader key={id} id={id} />;
}

function TimelineLoader({ id }: { id: string }) {
  const router = useRouter();
  const { locale, t } = useI18n();
  const [filters, setFilters] = useState<TimelineFilters>({});
  const [applied, setApplied] = useState<TimelineFilters>({});
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<EventTimelineResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const eventPath = `/organizer/events/${id}`;
  const loginPath = `/login?next=${encodeURIComponent(`${eventPath}/timeline`)}`;

  useEffect(() => {
    const token = readToken();
    if (!token) {
      router.replace(loginPath);
      return;
    }
    let active = true;
    getEventTimeline(token, id, applied, offset)
      .then((result) => {
        if (!active || readToken() !== token) return;
        setPage(result);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!active || readToken() !== token) return;
        if (err instanceof ApiError && err.status === 401) {
          clearSession();
          router.replace(loginPath);
          return;
        }
        setError(err);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [applied, id, loginPath, offset, router]);

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setOffset(0);
    setApplied({ ...filters });
  }

  function resetFilters() {
    setLoading(true);
    setError(null);
    setFilters({});
    setApplied({});
    setOffset(0);
  }

  function goToOffset(next: number) {
    setLoading(true);
    setError(null);
    setOffset(Math.max(0, next));
  }

  const actionLabels = t.history.actions as Record<string, string>;
  const actionLabel = (action: string) => actionLabels[action] ?? action;

  return (
    <div className="mx-auto max-w-5xl">
      <Link href={eventPath} className={textButtonClass}>
        {t.history.backToEvent}
      </Link>
      <h1 className="mt-3 text-2xl font-semibold">{t.history.timelineTitle}</h1>
      <p className="mt-2 text-sm text-zinc-600">{t.history.intro}</p>

      <form
        onSubmit={applyFilters}
        className="mt-6 grid gap-3 rounded-lg border border-zinc-200 bg-white p-4 sm:grid-cols-2 lg:grid-cols-5"
      >
        <label className="block text-sm font-medium">
          {t.history.dateFrom}
          <input
            type="date"
            value={filters.from ?? ''}
            onChange={(event) => setFilters({ ...filters, from: event.target.value || undefined })}
            className={fieldClass}
          />
        </label>
        <label className="block text-sm font-medium">
          {t.history.dateTo}
          <input
            type="date"
            value={filters.to ?? ''}
            onChange={(event) => setFilters({ ...filters, to: event.target.value || undefined })}
            className={fieldClass}
          />
        </label>
        <label className="block text-sm font-medium">
          {t.history.action}
          <select
            value={filters.action ?? ''}
            onChange={(event) => setFilters({ ...filters, action: event.target.value || undefined })}
            className={fieldClass}
          >
            <option value="">{t.history.allActions}</option>
            {(page?.actions ?? []).map((action) => (
              <option key={action} value={action}>
                {actionLabel(action)}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-end gap-3 lg:col-span-2">
          <button type="submit" disabled={loading} className={buttonClass}>
            {t.history.apply}
          </button>
          <button type="button" onClick={resetFilters} className={textButtonClass}>
            {t.history.reset}
          </button>
        </div>
      </form>

      {error ? (
        <p role="alert" className="mt-6 text-sm text-red-700">
          {errorText(error, t)}
        </p>
      ) : loading || !page ? (
        <p role="status" className="mt-6 text-sm text-zinc-600">
          {t.history.loading}
        </p>
      ) : page.entries.length === 0 ? (
        <p className="mt-6 text-sm text-zinc-600">{t.history.empty}</p>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-lg border border-zinc-200 bg-white">
          <table className="min-w-full text-sm">
            <thead className="bg-zinc-50 text-left text-xs uppercase text-zinc-500">
              <tr>
                <th className="px-4 py-3 font-medium">{t.history.when}</th>
                <th className="px-4 py-3 font-medium">{t.history.action}</th>
                <th className="px-4 py-3 font-medium">{t.history.actor}</th>
                <th className="px-4 py-3 font-medium">{t.history.entity}</th>
                <th className="px-4 py-3 font-medium">{t.history.description}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200">
              {page.entries.map((entry) => (
                <tr key={entry.id} className="align-top">
                  <td className="whitespace-nowrap px-4 py-3 text-zinc-600">
                    {formatWhen(entry.created_at, locale)}
                  </td>
                  <td className="px-4 py-3 font-medium">{actionLabel(entry.action)}</td>
                  <td className="px-4 py-3 text-zinc-600">
                    {entry.actor ? entry.actor.name : t.history.system}
                  </td>
                  <td className="px-4 py-3 text-zinc-600">
                    <span>{entry.entity_type}</span>
                    <span className="block font-mono text-xs text-zinc-400">
                      {entry.entity_id}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-zinc-700">{entry.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {page && (offset > 0 || page.entries.length === page.limit) ? (
        <div className="mt-4 flex gap-3">
          <button
            type="button"
            disabled={offset === 0 || loading}
            onClick={() => goToOffset(offset - page.limit)}
            className={buttonClass}
          >
            {t.history.previousPage}
          </button>
          <button
            type="button"
            disabled={page.entries.length < page.limit || loading}
            onClick={() => goToOffset(offset + page.limit)}
            className={buttonClass}
          >
            {t.history.nextPage}
          </button>
        </div>
      ) : null}
    </div>
  );
}
