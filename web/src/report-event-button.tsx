'use client';

import { useState, type FormEvent } from 'react';
import { ApiError, reportEvent } from '@/api';
import { useI18n } from '@/i18n/client';
import { errorText } from '@/i18n/errors';
import { readToken, useSessionUser } from '@/session';

// A small report form on the public event page, for logged-in users only (SRS 4.12).
// A logged-out visitor sees nothing: reporting is not a reason to interrupt browsing.
export function ReportEventButton({ eventId }: { eventId: string }) {
  const user = useSessionUser();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!user) return null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = reason.trim();
    if (!text || pending) return;

    setPending(true);
    setError(null);
    try {
      await reportEvent(eventId, text, readToken() ?? '');
      setDone(true);
      setOpen(false);
      setReason('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError(t.admin.reportAlready);
      } else {
        setError(errorText(err, t));
      }
    } finally {
      setPending(false);
    }
  }

  if (done) {
    return (
      <p className="mt-4 max-w-2xl rounded-md bg-green-50 p-3 text-sm text-green-800">
        {t.admin.reportThanks}
      </p>
    );
  }

  return (
    <section className="mt-4 max-w-2xl">
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50"
        >
          {t.admin.reportButton}
        </button>
      ) : (
        <form onSubmit={submit} className="rounded-lg border border-zinc-200 bg-white p-4">
          <label className="block text-sm font-medium text-zinc-800">
            {t.admin.reportReason}
            <textarea
              required
              maxLength={1000}
              rows={3}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder={t.admin.reportPlaceholder}
              className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-zinc-500"
            />
          </label>
          {error ? (
            <p role="alert" className="mt-2 text-sm text-red-700">
              {error}
            </p>
          ) : null}
          <div className="mt-3 flex gap-2">
            <button
              type="submit"
              disabled={pending || !reason.trim()}
              className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60"
            >
              {pending ? t.admin.reportSending : t.admin.reportSubmit}
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setError(null);
              }}
              className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700"
            >
              {t.admin.reportCancel}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
