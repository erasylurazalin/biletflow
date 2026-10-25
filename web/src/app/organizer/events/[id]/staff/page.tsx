'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState, type FormEvent } from 'react';
import { ApiError, assignStaff, listStaff, removeStaff, type StaffMember } from '@/api';
import { useI18n } from '@/i18n/client';
import { errorText } from '@/i18n/errors';
import { clearSession, readToken } from '@/session';

const fieldClass =
  'mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-500';
const buttonClass =
  'rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-60';

function DoorStaff() {
  const { id: eventId } = useParams<{ id: string }>();
  const router = useRouter();
  const { t } = useI18n();
  const [staff, setStaff] = useState<StaffMember[] | null>(null);
  const [email, setEmail] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loading = staff === null && error === null;

  const showError = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) {
        clearSession();
        router.replace('/login');
        return;
      }
      if (err instanceof ApiError && err.status === 403) {
        setError(t.organizer.ownerOnly);
        return;
      }
      setError(errorText(err, t));
    },
    [router, t],
  );

  const refresh = useCallback(async () => {
    const token = readToken();
    if (!token) {
      router.replace('/login');
      return;
    }
    setPending('refresh');
    try {
      setStaff(await listStaff(eventId, token));
      setError(null);
    } catch (err) {
      showError(err);
    } finally {
      setPending(null);
    }
  }, [eventId, router, showError]);

  useEffect(() => {
    const token = readToken();
    if (!token) {
      router.replace('/login');
      return;
    }
    let cancelled = false;
    listStaff(eventId, token)
      .then((next) => {
        if (cancelled) return;
        setStaff(next);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) showError(err);
      });
    return () => {
      cancelled = true;
    };
  }, [eventId, router, showError]);

  async function perform(step: string, action: (token: string) => Promise<void>): Promise<void> {
    const token = readToken();
    if (!token) {
      router.replace('/login');
      return;
    }
    setError(null);
    setPending(step);
    try {
      await action(token);
      await refresh();
    } catch (err) {
      showError(err);
    } finally {
      setPending(null);
    }
  }

  async function submitStaff(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    await perform('add', async (token) => {
      await assignStaff(eventId, email, token);
      setEmail('');
    });
  }

  return (
    <div className="mx-auto max-w-2xl">
      <Link href={`/events/${eventId}`} className="text-sm text-zinc-500 hover:text-zinc-800">
        {t.organizer.back}
      </Link>
      <h1 className="mt-4 text-2xl font-semibold">{t.staff.title}</h1>
      <p className="mt-2 text-sm text-zinc-600">
        {t.staff.intro}
      </p>

      {error ? (
        <p role="alert" className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      {loading ? <p className="mt-6 text-sm text-zinc-600">{t.staff.loading}</p> : null}
      {!loading && !staff && error ? (
        <button
          type="button"
          disabled={pending !== null}
          onClick={() => void refresh()}
          className={`${buttonClass} mt-4`}
        >
          {pending === 'refresh' ? t.common.loading : t.organizer.tryAgain}
        </button>
      ) : null}

      {staff ? (
        <div className="mt-6 space-y-6">
          <section className="rounded-lg border border-zinc-200 bg-white p-5">
            <h2 className="font-medium">{t.staff.current}</h2>
            {staff.length === 0 ? (
              <p className="mt-3 text-sm text-zinc-600">{t.staff.nobody}</p>
            ) : (
              <ul className="mt-3 divide-y divide-zinc-200">
                {staff.map((member) => (
                  <li key={member.id} className="flex items-center justify-between gap-4 py-3">
                    <div>
                      <p className="text-sm font-medium text-zinc-900">{member.name}</p>
                      <p className="text-sm text-zinc-600">{member.email}</p>
                    </div>
                    <button
                      type="button"
                      disabled={pending !== null}
                      onClick={() =>
                        void perform(`remove:${member.id}`, async (token) => {
                          await removeStaff(eventId, member.id, token);
                        })
                      }
                      className={buttonClass}
                    >
                      {pending === `remove:${member.id}` ? t.staff.removing : t.staff.remove}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="rounded-lg border border-zinc-200 bg-white p-5">
            <h2 className="font-medium">{t.staff.addTitle}</h2>
            <form onSubmit={(event) => void submitStaff(event)} className="mt-3 space-y-3">
              <label className="block text-sm font-medium text-zinc-800">
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
              <button type="submit" disabled={pending !== null} className={buttonClass}>
                {pending === 'add' ? t.staff.adding : t.staff.add}
              </button>
            </form>
          </section>
        </div>
      ) : null}
    </div>
  );
}

export default function StaffPage() {
  const { t } = useI18n();
  return (
    <Suspense fallback={<p className="text-sm text-zinc-600">{t.staff.loading}</p>}>
      <DoorStaff />
    </Suspense>
  );
}
