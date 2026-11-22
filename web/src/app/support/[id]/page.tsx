'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import {
  ApiError,
  formatWhen,
  getSupportCase,
  replyToSupportCase,
  updateSupportCase,
  type SupportCaseDetail,
  type SupportMessage,
  type SupportStatus,
} from '@/api';
import { useI18n } from '@/i18n/client';
import { errorText } from '@/i18n/errors';
import { fill } from '@/i18n/format';
import { clearSession, readToken } from '@/session';

const statusStyles: Record<SupportStatus, string> = {
  open: 'bg-amber-50 text-amber-900 ring-amber-200',
  in_progress: 'bg-blue-50 text-blue-900 ring-blue-200',
  waiting_for_customer: 'bg-violet-50 text-violet-900 ring-violet-200',
  resolved: 'bg-emerald-50 text-emerald-900 ring-emerald-200',
};

const statuses: SupportStatus[] = ['open', 'in_progress', 'waiting_for_customer', 'resolved'];

export default function SupportCasePage() {
  const { id: caseId } = useParams<{ id: string }>();
  const router = useRouter();
  const { locale, t } = useI18n();
  const [caseData, setCaseData] = useState<SupportCaseDetail | null>(null);
  const [messages, setMessages] = useState<SupportMessage[]>([]);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reply, setReply] = useState('');
  const [replying, setReplying] = useState(false);
  const [saving, setSaving] = useState(false);
  const loginPath = `/login?next=${encodeURIComponent(`/support/${caseId}`)}`;

  useEffect(() => {
    const token = readToken();
    if (!token) {
      router.replace(loginPath);
      return;
    }

    let cancelled = false;

    // SRS 9: REST with periodic refresh. No sockets, and overlapping requests are
    // avoided by scheduling the next poll only after this one settles.
    async function load() {
      try {
        const next = await getSupportCase(token!, caseId);
        if (cancelled) return;
        setCaseData(next.case);
        setMessages(next.messages);
        setError(null);
      } catch (err: unknown) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          clearSession();
          router.replace(loginPath);
          return;
        }
        if (err instanceof ApiError && err.status === 404) {
          setNotFound(true);
          return;
        }
        setError(errorText(err, t));
      }
    }

    void load();
    const timer = setInterval(() => void load(), 10_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [caseId, loginPath, router, t]);

  async function submitReply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (replying || reply.trim() === '') return;
    const token = readToken();
    if (!token) {
      router.replace(loginPath);
      return;
    }

    setReplying(true);
    setError(null);
    try {
      const message = await replyToSupportCase(token, caseId, reply.trim());
      setMessages((current) => [...current, message]);
      setReply('');
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 401) {
        clearSession();
        router.replace(loginPath);
        return;
      }
      setError(errorText(err, t));
    } finally {
      setReplying(false);
    }
  }

  async function saveCase(input: { status?: SupportStatus; assigned_to?: string | null }) {
    const token = readToken();
    if (!token || saving) return;

    setSaving(true);
    setError(null);
    try {
      const updated = await updateSupportCase(token, caseId, input);
      setCaseData(updated);
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 401) {
        clearSession();
        router.replace(loginPath);
        return;
      }
      setError(err instanceof ApiError ? errorText(err, t) : t.support.saveError);
    } finally {
      setSaving(false);
    }
  }

  if (notFound) {
    return (
      <div className="mx-auto max-w-3xl">
        <h1 className="text-2xl font-semibold">{t.support.notFoundTitle}</h1>
        <p className="mt-2 text-sm text-zinc-600">{t.support.notFoundText}</p>
        <Link href="/support" className="mt-5 inline-block text-sm font-medium underline">
          {t.support.back}
        </Link>
      </div>
    );
  }

  if (!caseData) {
    return (
      <div className="mx-auto max-w-3xl">
        {error ? (
          <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-700">
            {error}
          </p>
        ) : (
          <p className="text-sm text-zinc-600">{t.support.loading}</p>
        )}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl">
      <Link href="/support" className="text-sm text-zinc-500 hover:text-zinc-800">
        {t.support.back}
      </Link>

      <div className="mt-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{caseData.subject}</h1>
          <p className="mt-1 text-sm text-zinc-600">
            {caseData.event_title ?? t.support.noEvent} ·{' '}
            {fill(t.support.openedBy, { name: caseData.opened_by_name })}
          </p>
          <p className="mt-1 text-sm text-zinc-500">
            {t.support.category[caseData.category]} ·{' '}
            {caseData.role === 'opener' ? t.support.roleOpener : t.support.roleResponder}
          </p>
        </div>
        <span
          className={`rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${statusStyles[caseData.status]}`}
        >
          {t.support.status[caseData.status]}
        </span>
      </div>

      {caseData.role === 'responder' ? (
        <section className="mt-5 grid gap-3 rounded-lg border border-zinc-200 bg-white p-4 sm:grid-cols-2">
          <label className="block text-sm font-medium">
            {t.support.statusLabel}
            <select
              value={caseData.status}
              disabled={saving}
              onChange={(event) => void saveCase({ status: event.target.value as SupportStatus })}
              className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm"
            >
              {statuses.map((value) => (
                <option key={value} value={value}>
                  {t.support.status[value]}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm font-medium">
            {t.support.assignedLabel}
            <select
              value={caseData.assigned_to ?? ''}
              disabled={saving}
              onChange={(event) => void saveCase({ assigned_to: event.target.value || null })}
              className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm"
            >
              <option value="">{t.support.unassigned}</option>
              {caseData.responders.map((responder) => (
                <option key={responder.id} value={responder.id}>
                  {responder.name}
                </option>
              ))}
            </select>
          </label>
          {saving ? <p className="text-xs text-zinc-500">{t.support.saving}</p> : null}
        </section>
      ) : null}

      {error ? (
        <p role="alert" className="mt-5 rounded-md bg-red-50 p-3 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      <section className="mt-6">
        <h2 className="text-lg font-medium">{t.support.thread}</h2>
        <ul className="mt-3 space-y-3">
          {messages.map((message) => (
            <li
              key={message.id}
              className={`rounded-lg border p-4 ${
                message.is_responder ? 'border-blue-200 bg-blue-50' : 'border-zinc-200 bg-white'
              }`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-500">
                <p className="font-medium text-zinc-700">
                  {message.author_name}
                  {message.is_responder ? (
                    <span className="ml-2 rounded bg-blue-100 px-1.5 py-0.5 text-blue-900">
                      {t.support.staff}
                    </span>
                  ) : null}
                </p>
                <p>{formatWhen(message.created_at, locale)}</p>
              </div>
              <p className="mt-2 whitespace-pre-wrap text-sm text-zinc-800">{message.body}</p>
            </li>
          ))}
        </ul>
      </section>

      <form onSubmit={(event) => void submitReply(event)} className="mt-6">
        <label className="block text-sm font-medium">
          {t.support.reply}
          <textarea
            value={reply}
            onChange={(event) => setReply(event.target.value)}
            required
            maxLength={5000}
            rows={4}
            placeholder={t.support.replyPlaceholder}
            className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm"
          />
        </label>
        <button
          type="submit"
          disabled={replying || reply.trim() === ''}
          className="mt-3 rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          {replying ? t.support.replying : t.support.reply}
        </button>
      </form>
    </div>
  );
}
