'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  Suspense,
  useCallback,
  useEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import {
  acceptPaidSalesTerms,
  activatePaidSales,
  ApiError,
  getPaidSales,
  payActivationFee,
  savePayoutAccount,
  verifyOrganizerIdentity,
  type PaidSales,
} from '@/api';
import { clearSession, readToken } from '@/session';

const fieldClass =
  'mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-500';
const buttonClass =
  'rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-60';

function ChecklistItem({
  number,
  title,
  done,
  children,
}: {
  number: number;
  title: string;
  done: boolean;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-5">
      <div className="flex items-center justify-between gap-4">
        <h2 className="font-medium">
          {number}. {title}
        </h2>
        <span
          className={`rounded-full px-2.5 py-1 text-xs font-medium ${
            done ? 'bg-green-100 text-green-800' : 'bg-zinc-100 text-zinc-600'
          }`}
        >
          {done ? 'Done' : 'Not done'}
        </span>
      </div>
      <div className="mt-3 text-sm text-zinc-600">{children}</div>
    </section>
  );
}

function PaidSalesChecklist() {
  const { id: eventId } = useParams<{ id: string }>();
  const router = useRouter();
  const [paidSales, setPaidSales] = useState<PaidSales | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const loading = paidSales === null && error === null;

  const showError = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) {
        clearSession();
        router.replace('/login');
        return;
      }
      if (err instanceof ApiError && err.status === 403) {
        setError("Only the event's organizer can do this");
        return;
      }
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
    },
    [router],
  );

  const refresh = useCallback(async () => {
    const token = readToken();
    if (!token) {
      router.replace('/login');
      return;
    }
    try {
      setPaidSales(await getPaidSales(eventId, token));
      setError(null);
    } catch (err) {
      showError(err);
    }
  }, [eventId, router, showError]);

  useEffect(() => {
    const token = readToken();
    if (!token) {
      router.replace('/login');
      return;
    }
    let cancelled = false;
    getPaidSales(eventId, token)
      .then((next) => {
        if (cancelled) return;
        setPaidSales(next);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) showError(err);
      });
    return () => {
      cancelled = true;
    };
  }, [eventId, router, showError]);

  async function perform(
    step: string,
    action: (token: string) => Promise<PaidSales | void>,
  ): Promise<void> {
    const token = readToken();
    if (!token) {
      router.replace('/login');
      return;
    }
    setError(null);
    setPending(step);
    try {
      const next = await action(token);
      if (next) {
        setPaidSales(next);
      } else {
        await refresh();
      }
    } catch (err) {
      showError(err);
    } finally {
      setPending(null);
    }
  }

  async function submitPayout(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await perform('payout', async (token) => {
      await savePayoutAccount(token, {
        bank_name: String(data.get('bank_name') ?? ''),
        iban: String(data.get('iban') ?? ''),
        account_holder: String(data.get('account_holder') ?? ''),
      });
    });
  }

  const checklist = paidSales?.checklist;
  const ready = checklist !== undefined && Object.values(checklist).every(Boolean);
  const fee = paidSales
    ? `${(paidSales.activation_fee.amount / 100).toLocaleString('en-US')} ${paidSales.activation_fee.currency}`
    : '';

  return (
    <div className="mx-auto max-w-2xl">
      <Link href={`/events/${eventId}`} className="text-sm text-zinc-500 hover:text-zinc-800">
        ← Event
      </Link>
      <h1 className="mt-4 text-2xl font-semibold">Activate paid sales</h1>
      <p className="mt-2 text-sm text-zinc-600">
        Complete this checklist for one event. Identity and payout details belong to your
        organizer profile.
      </p>
      <p className="mt-4 rounded-md bg-amber-50 p-3 text-sm text-amber-900">
        Demonstration only. Identity checks, payments and payouts are simulated. No real money
        moves.
      </p>

      {error ? (
        <p role="alert" className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      {loading ? <p className="mt-6 text-sm text-zinc-600">Loading checklist…</p> : null}
      {!loading && !paidSales && error ? (
        <button type="button" onClick={() => void refresh()} className={`${buttonClass} mt-4`}>
          Try again
        </button>
      ) : null}

      {paidSales && checklist ? (
        <div className="mt-6 space-y-4">
          <ChecklistItem number={1} title="Paid ticket type" done={checklist.paid_ticket_type}>
            {checklist.paid_ticket_type ? (
              <p>This event has a ticket type with a price above 0.</p>
            ) : (
              <p>
                Add a ticket type with a price above 0 in the{' '}
                <Link href={`/events/${eventId}`} className="font-medium text-zinc-900 underline">
                  event ticket types
                </Link>
                , then reload this checklist.
              </p>
            )}
          </ChecklistItem>

          <ChecklistItem number={2} title="Simulated identity check" done={checklist.identity_verified}>
            <p>No documents are checked or stored.</p>
            <button
              type="button"
              disabled={pending !== null || checklist.identity_verified}
              onClick={() =>
                void perform('identity', async (token) => {
                  await verifyOrganizerIdentity(token);
                })
              }
              className={`${buttonClass} mt-3`}
            >
              {checklist.identity_verified
                ? 'Identity check complete'
                : pending === 'identity'
                  ? 'Checking…'
                  : 'Complete simulated identity check'}
            </button>
          </ChecklistItem>

          <ChecklistItem number={3} title="Payout account" done={checklist.payout_account}>
            <p>Demonstration payout details. Nothing is paid to this account.</p>
            {checklist.payout_account ? (
              <p className="mt-2 font-medium text-zinc-800">Payout account saved.</p>
            ) : (
              <form onSubmit={(event) => void submitPayout(event)} className="mt-3 space-y-3">
                <label className="block text-sm font-medium text-zinc-800">
                  Bank name
                  <input name="bank_name" required className={fieldClass} />
                </label>
                <label className="block text-sm font-medium text-zinc-800">
                  IBAN
                  <input
                    name="iban"
                    required
                    autoComplete="off"
                    placeholder="KZ000000000000000000"
                    className={fieldClass}
                  />
                </label>
                <label className="block text-sm font-medium text-zinc-800">
                  Account holder
                  <input name="account_holder" required className={fieldClass} />
                </label>
                <button type="submit" disabled={pending !== null} className={buttonClass}>
                  {pending === 'payout' ? 'Saving…' : 'Save payout account'}
                </button>
              </form>
            )}
          </ChecklistItem>

          <ChecklistItem number={4} title="Simulated activation fee" done={checklist.activation_fee_paid}>
            <p>Demonstration payment of {fee}. No real money will be charged.</p>
            <button
              type="button"
              disabled={pending !== null || checklist.activation_fee_paid}
              onClick={() => void perform('fee', (token) => payActivationFee(eventId, token))}
              className={`${buttonClass} mt-3`}
            >
              {checklist.activation_fee_paid
                ? 'Demo payment recorded'
                : pending === 'fee'
                  ? 'Recording demo payment…'
                  : `Pay simulated fee: ${fee}`}
            </button>
          </ChecklistItem>

          <ChecklistItem number={5} title="Paid-event terms" done={checklist.terms_accepted}>
            {checklist.terms_accepted ? (
              <p>Paid-event terms accepted.</p>
            ) : (
              <>
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={termsAccepted}
                    onChange={(event) => setTermsAccepted(event.target.checked)}
                    className="mt-1"
                  />
                  <span>I accept the paid-event terms for this event.</span>
                </label>
                <button
                  type="button"
                  disabled={pending !== null || !termsAccepted}
                  onClick={() => void perform('terms', (token) => acceptPaidSalesTerms(eventId, token))}
                  className={`${buttonClass} mt-3`}
                >
                  {pending === 'terms' ? 'Accepting…' : 'Accept terms'}
                </button>
              </>
            )}
          </ChecklistItem>

          <button
            type="button"
            disabled={pending !== null || !ready || paidSales.status === 'active'}
            onClick={() => void perform('activate', (token) => activatePaidSales(eventId, token))}
            className={`${buttonClass} w-full`}
          >
            {paidSales.status === 'active'
              ? 'Paid sales active'
              : pending === 'activate'
                ? 'Activating…'
                : 'Activate paid sales'}
          </button>
        </div>
      ) : null}
    </div>
  );
}

export default function PaidSalesPage() {
  return (
    <Suspense fallback={<p className="text-sm text-zinc-600">Loading checklist…</p>}>
      <PaidSalesChecklist />
    </Suspense>
  );
}
