'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState, type FormEvent } from 'react';
import {
  formatWhen,
  listDevOutbox,
  listMyEmails,
  resendVerification,
  type InboxEmail,
  type User,
} from '@/api';
import { useI18n } from '@/i18n/client';
import { errorText } from '@/i18n/errors';
import { readToken, useSessionUser } from '@/session';

const fieldClass =
  'mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-500';
const buttonClass =
  'rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-60';

function EmailBody({ body }: { body: string }) {
  return (
    <p className="mt-2 whitespace-pre-wrap text-sm text-zinc-700">
      {body.split(/(https?:\/\/[^\s]+)/g).map((part, index) =>
        /^https?:\/\//.test(part) ? (
          <a
            key={index}
            href={part}
            className="break-all text-zinc-900 underline hover:text-zinc-600"
          >
            {part}
          </a>
        ) : (
          part
        ),
      )}
    </p>
  );
}

function EmailList({ emails }: { emails: InboxEmail[] | null }) {
  const { locale, t } = useI18n();
  if (emails === null) return null;
  if (emails.length === 0) return <p className="mt-6 text-sm text-zinc-600">{t.inbox.empty}</p>;

  return (
    <ul className="mt-6 space-y-4">
      {emails.map((email) => (
        <li key={email.id} className="rounded-lg border border-zinc-200 bg-white p-5">
          <h2 className="font-medium">{email.subject}</h2>
          <p className="mt-1 text-xs text-zinc-500">{formatWhen(email.created_at, locale)}</p>
          <EmailBody body={email.body} />
        </li>
      ))}
    </ul>
  );
}

function MyInbox({ user }: { user: User }) {
  const { t } = useI18n();
  const [emails, setEmails] = useState<InboxEmail[] | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = readToken();
    if (!token) return;

    let cancelled = false;
    listMyEmails(token)
      .then((next) => {
        if (cancelled) return;
        setEmails(next);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorText(err, t));
      });

    return () => {
      cancelled = true;
    };
  }, [user, t]);

  async function resend() {
    const token = readToken();
    if (!token || pending) return;

    setError(null);
    setPending(true);
    try {
      await resendVerification(token);
      setEmails(await listMyEmails(token));
    } catch (err) {
      setError(errorText(err, t));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mt-6">
      {user.email_verified === false ? (
        <button type="button" disabled={pending} onClick={() => void resend()} className={buttonClass}>
          {pending ? t.inbox.sending : t.inbox.resend}
        </button>
      ) : null}
      {error ? (
        <p role="alert" className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-700">
          {error}
        </p>
      ) : null}
      {emails === null && error === null ? (
        <p className="mt-6 text-sm text-zinc-600">{t.inbox.loading}</p>
      ) : null}
      <EmailList emails={emails} />
    </div>
  );
}

function OutboxLookup({ initialEmail }: { initialEmail: string }) {
  const { t } = useI18n();
  const [email, setEmail] = useState(initialEmail);
  const [emails, setEmails] = useState<InboxEmail[] | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    setError(null);
    setPending(true);
    try {
      setEmails(await listDevOutbox(email));
    } catch (err) {
      setError(errorText(err, t));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mt-6">
      <form onSubmit={onSubmit} className="max-w-sm">
        <label className="block text-sm font-medium">
          {t.common.email}
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className={fieldClass}
          />
        </label>
        <button type="submit" disabled={pending} className={`${buttonClass} mt-3`}>
          {pending ? t.common.loading : t.inbox.show}
        </button>
      </form>
      {error ? (
        <p role="alert" className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-700">
          {error}
        </p>
      ) : null}
      <EmailList emails={emails} />
    </div>
  );
}

function InboxContent() {
  const user = useSessionUser();
  const searchParams = useSearchParams();

  return user ? (
    <MyInbox user={user} />
  ) : (
    <OutboxLookup initialEmail={searchParams.get('email') ?? ''} />
  );
}

export default function InboxPage() {
  const { t } = useI18n();
  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-2xl font-semibold">{t.inbox.title}</h1>
      <p className="mt-2 text-sm text-zinc-600">
        {t.inbox.intro}
      </p>
      <Suspense fallback={<p className="mt-6 text-sm text-zinc-600">{t.inbox.loading}</p>}>
        <InboxContent />
      </Suspense>
    </div>
  );
}
