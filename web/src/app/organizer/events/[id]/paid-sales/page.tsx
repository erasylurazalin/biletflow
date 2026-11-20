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
  formatMoney,
  getPaidSales,
  payActivationFee,
  savePayoutAccount,
  verifyOrganizerIdentity,
  type PaidSales,
} from '@/api';
import { useI18n } from '@/i18n/client';
import { errorText } from '@/i18n/errors';
import { fill } from '@/i18n/format';
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
  const { t } = useI18n();
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
          {done ? t.paidSales.done : t.paidSales.notDone}
        </span>
      </div>
      <div className="mt-3 text-sm text-zinc-600">{children}</div>
    </section>
  );
}

function PaidSalesChecklist() {
  const { id: eventId } = useParams<{ id: string }>();
  const router = useRouter();
  const { locale, t } = useI18n();
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
  const fee = paidSales ? formatMoney(paidSales.activation_fee.amount, locale) : '';
  const [paidTypeBefore, paidTypeAfter] = t.paidSales.paidTypeTodo.split('{link}');

  return (
    <div className="mx-auto max-w-2xl">
      <Link href={`/events/${eventId}`} className="text-sm text-zinc-500 hover:text-zinc-800">
        {t.organizer.back}
      </Link>
      <h1 className="mt-4 text-2xl font-semibold">{t.paidSales.title}</h1>
      <p className="mt-2 text-sm text-zinc-600">
        {t.paidSales.intro}
      </p>
      <p className="mt-4 rounded-md bg-amber-50 p-3 text-sm text-amber-900">
        {t.paidSales.demo}
      </p>

      {error ? (
        <p role="alert" className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      {loading ? <p className="mt-6 text-sm text-zinc-600">{t.paidSales.loading}</p> : null}
      {!loading && !paidSales && error ? (
        <button type="button" onClick={() => void refresh()} className={`${buttonClass} mt-4`}>
          {t.organizer.tryAgain}
        </button>
      ) : null}

      {paidSales && checklist ? (
        <div className="mt-6 space-y-4">
          <ChecklistItem number={1} title={t.paidSales.paidType} done={checklist.paid_ticket_type}>
            {checklist.paid_ticket_type ? (
              <p>{t.paidSales.paidTypeDone}</p>
            ) : (
              <p>
                {paidTypeBefore}
                <Link href={`/events/${eventId}`} className="font-medium text-zinc-900 underline">
                  {t.paidSales.paidTypeLink}
                </Link>
                {paidTypeAfter}
              </p>
            )}
          </ChecklistItem>

          <ChecklistItem number={2} title={t.paidSales.identity} done={checklist.identity_verified}>
            <p>{t.paidSales.identityNote}</p>
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
                ? t.paidSales.identityDone
                : pending === 'identity'
                  ? t.paidSales.identityChecking
                  : t.paidSales.identityButton}
            </button>
          </ChecklistItem>

          <ChecklistItem number={3} title={t.paidSales.payout} done={checklist.payout_account}>
            <p>{t.paidSales.payoutNote}</p>
            {checklist.payout_account ? (
              <p className="mt-2 font-medium text-zinc-800">{t.paidSales.payoutSaved}</p>
            ) : (
              <form onSubmit={(event) => void submitPayout(event)} className="mt-3 space-y-3">
                <label className="block text-sm font-medium text-zinc-800">
                  {t.paidSales.bankName}
                  <input name="bank_name" required className={fieldClass} />
                </label>
                <label className="block text-sm font-medium text-zinc-800">
                  {t.paidSales.iban}
                  <input
                    name="iban"
                    required
                    autoComplete="off"
                    placeholder="KZ000000000000000000"
                    className={fieldClass}
                  />
                </label>
                <label className="block text-sm font-medium text-zinc-800">
                  {t.paidSales.accountHolder}
                  <input name="account_holder" required className={fieldClass} />
                </label>
                <button type="submit" disabled={pending !== null} className={buttonClass}>
                  {pending === 'payout' ? t.paidSales.saving : t.paidSales.savePayout}
                </button>
              </form>
            )}
          </ChecklistItem>

          <ChecklistItem number={4} title={t.paidSales.fee} done={checklist.activation_fee_paid}>
            <p>{fill(t.paidSales.feeNote, { fee })}</p>
            <button
              type="button"
              disabled={pending !== null || checklist.activation_fee_paid}
              onClick={() => void perform('fee', (token) => payActivationFee(eventId, token))}
              className={`${buttonClass} mt-3`}
            >
              {checklist.activation_fee_paid
                ? t.paidSales.feeDone
                : pending === 'fee'
                  ? t.paidSales.feePaying
                  : fill(t.paidSales.feeButton, { fee })}
            </button>
          </ChecklistItem>

          <ChecklistItem number={5} title={t.paidSales.terms} done={checklist.terms_accepted}>
            {checklist.terms_accepted ? (
              <p>{t.paidSales.termsDone}</p>
            ) : (
              <>
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={termsAccepted}
                    onChange={(event) => setTermsAccepted(event.target.checked)}
                    className="mt-1"
                  />
                  <span>{t.paidSales.termsCheckbox}</span>
                </label>
                <button
                  type="button"
                  disabled={pending !== null || !termsAccepted}
                  onClick={() => void perform('terms', (token) => acceptPaidSalesTerms(eventId, token))}
                  className={`${buttonClass} mt-3`}
                >
                  {pending === 'terms' ? t.paidSales.accepting : t.paidSales.accept}
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
              ? t.paidSales.active
              : pending === 'activate'
                ? t.paidSales.activating
                : t.paidSales.activate}
          </button>
        </div>
      ) : null}
    </div>
  );
}

export default function PaidSalesPage() {
  const { t } = useI18n();
  return (
    <Suspense fallback={<p className="text-sm text-zinc-600">{t.paidSales.loading}</p>}>
      <PaidSalesChecklist />
    </Suspense>
  );
}
