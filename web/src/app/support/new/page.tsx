'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState, type FormEvent } from 'react';
import {
  ApiError,
  createSupportCase,
  getEventForBrowser,
  getOrder,
  listMyTickets,
  type SupportCategory,
  type SupportKind,
} from '@/api';
import { useI18n } from '@/i18n/client';
import { errorText } from '@/i18n/errors';
import { fill } from '@/i18n/format';
import { clearSession, readToken } from '@/session';

const categories: SupportCategory[] = [
  'ticket_delivery',
  'payment',
  'refund',
  'seating',
  'event_information',
  'check_in',
  'account',
  'technical',
];

const fieldClass = 'mt-1 block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm';

function NewSupportCase() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { t } = useI18n();

  const kindParam = searchParams.get('kind');
  const eventParam = searchParams.get('event');
  const orderParam = searchParams.get('order');
  const ticketParam = searchParams.get('ticket');
  const hasEventContext = Boolean(eventParam || orderParam || ticketParam);
  const kind: SupportKind | 'none' =
    kindParam === 'platform' ? 'platform' : hasEventContext ? 'event' : 'none';

  const [eventId, setEventId] = useState<string | null>(eventParam);
  const [eventTitle, setEventTitle] = useState<string | null>(null);
  const [ticketCode, setTicketCode] = useState<string | null>(null);
  const [contextLoading, setContextLoading] = useState(kind === 'event');
  const [contextError, setContextError] = useState(false);
  const [category, setCategory] = useState<SupportCategory>(
    kind === 'platform' ? 'account' : 'event_information',
  );
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const next = `/support/new?${searchParams.toString()}`;

  useEffect(() => {
    const token = readToken();
    if (!token) {
      router.replace(`/login?next=${encodeURIComponent(next)}`);
      return;
    }
    if (kind !== 'event') return;

    let cancelled = false;

    async function loadContext() {
      let resolvedEventId = eventParam;
      let title: string | null = null;
      let code: string | null = null;

      try {
        // The ticket is the strongest context: it also gives the event when the URL
        // came without one, and its human code is what the attendee recognizes. An
        // order does the same. The public event read is the fallback for an event-only
        // link (the event page's Get help).
        if (ticketParam) {
          const tickets = await listMyTickets(token!);
          const found = tickets.find((ticket) => ticket.id === ticketParam);
          if (!found) {
            if (!cancelled) setContextError(true);
            return;
          }
          code = found.code;
          resolvedEventId = found.event.id;
          title = found.event.title;
        } else if (orderParam) {
          const order = await getOrder(token!, orderParam);
          resolvedEventId = order.event.id;
          title = order.event.title;
        } else if (eventParam) {
          const event = await getEventForBrowser(eventParam);
          resolvedEventId = event.id;
          title = event.title;
        }

        if (!resolvedEventId) {
          if (!cancelled) setContextError(true);
          return;
        }
        if (!cancelled) {
          setEventId(resolvedEventId);
          setEventTitle(title);
          setTicketCode(code);
        }
      } catch (err: unknown) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          clearSession();
          router.replace(`/login?next=${encodeURIComponent(next)}`);
          return;
        }
        setContextError(true);
      } finally {
        if (!cancelled) setContextLoading(false);
      }
    }

    void loadContext();
    return () => {
      cancelled = true;
    };
  }, [eventParam, kind, next, orderParam, router, ticketParam]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const token = readToken();
    if (!token) {
      router.replace(`/login?next=${encodeURIComponent(next)}`);
      return;
    }
    if (pending) return;

    if (kind === 'event' && !eventId) {
      setContextError(true);
      return;
    }

    setPending(true);
    setError(null);
    try {
      const created = await createSupportCase(token, {
        kind: kind === 'platform' ? 'platform' : 'event',
        ...(kind === 'event'
          ? {
              event_id: eventId!,
              ...(orderParam ? { order_id: orderParam } : {}),
              ...(ticketParam ? { ticket_id: ticketParam } : {}),
            }
          : {}),
        category,
        subject: subject.trim(),
        body: body.trim(),
      });
      router.push(`/support/${created.id}`);
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 401) {
        clearSession();
        router.replace(`/login?next=${encodeURIComponent(next)}`);
        return;
      }
      if (err instanceof ApiError && err.status === 403 && kind === 'platform') {
        setError(t.support.platformOnly);
      } else {
        setError(errorText(err, t));
      }
    } finally {
      setPending(false);
    }
  }

  if (kind === 'none') {
    return (
      <div className="mx-auto max-w-xl">
        <h1 className="text-2xl font-semibold">{t.support.eventRequiredTitle}</h1>
        <p className="mt-3 text-sm text-zinc-600">{t.support.eventRequiredText}</p>
        <Link href="/support" className="mt-5 inline-block text-sm font-medium underline">
          {t.support.back}
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl">
      <Link href="/support" className="text-sm text-zinc-500 hover:text-zinc-800">
        {t.support.back}
      </Link>
      <h1 className="mt-4 text-2xl font-semibold">{t.support.newTitle}</h1>
      <p className="mt-1 text-sm text-zinc-600">{t.support.newIntro}</p>

      <p className="mt-4 rounded-md border border-zinc-200 bg-white p-3 text-sm text-zinc-700">
        {kind === 'platform'
          ? t.support.aboutPlatform
          : contextLoading
            ? t.support.loading
            : eventId
              ? ticketCode
                ? fill(t.support.aboutTicket, { event: eventTitle ?? eventId, code: ticketCode })
                : fill(t.support.aboutEvent, { event: eventTitle ?? eventId })
              : t.support.noEventContext}
      </p>

      {contextError ? (
        <p role="alert" className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-700">
          {t.support.contextMissing}
        </p>
      ) : null}

      <form onSubmit={(event) => void submit(event)} className="mt-5 space-y-4">
        <label className="block text-sm font-medium">
          {t.support.categoryLabel}
          <select
            value={category}
            onChange={(event) => setCategory(event.target.value as SupportCategory)}
            className={fieldClass}
          >
            {categories.map((value) => (
              <option key={value} value={value}>
                {t.support.category[value]}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm font-medium">
          {t.support.subjectLabel}
          <input
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
            required
            maxLength={200}
            placeholder={t.support.subjectPlaceholder}
            className={fieldClass}
          />
        </label>
        <label className="block text-sm font-medium">
          {t.support.messageLabel}
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            required
            maxLength={5000}
            rows={7}
            placeholder={t.support.messagePlaceholder}
            className={fieldClass}
          />
        </label>

        {error ? (
          <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-700">
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={pending || contextLoading || (kind === 'event' && !eventId)}
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          {pending ? t.support.submitting : t.support.submit}
        </button>
      </form>
    </div>
  );
}

export default function NewSupportCasePage() {
  const { t } = useI18n();
  return (
    <Suspense fallback={<p className="text-sm text-zinc-600">{t.support.loading}</p>}>
      <NewSupportCase />
    </Suspense>
  );
}
