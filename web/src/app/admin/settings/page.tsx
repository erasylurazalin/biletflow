'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  ApiError,
  formatMoney,
  getAdminSettings,
  updateAdminSettings,
  type AdminSettings,
} from '@/api';
import { useI18n } from '@/i18n/client';
import { errorText } from '@/i18n/errors';
import { fill } from '@/i18n/format';
import { clearSession, readToken } from '@/session';
import { AdminShell } from '../admin-shell';

const fieldClass =
  'mt-1 w-full max-w-xs rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-500';
const buttonClass =
  'rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60';

export default function AdminSettingsPage() {
  const router = useRouter();
  const { locale, t } = useI18n();
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [fee, setFee] = useState('');
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const showError = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) {
        clearSession();
        router.replace('/login?next=/admin/settings');
        return;
      }
      if (err instanceof ApiError && err.status === 403) {
        setError(t.admin.notAllowed);
        return;
      }
      setError(errorText(err, t));
    },
    [router, t],
  );

  useEffect(() => {
    let cancelled = false;
    getAdminSettings(readToken() ?? '')
      .then((next) => {
        if (cancelled) return;
        setSettings(next);
        setFee((next.activation_fee / 100).toString());
      })
      .catch((err: unknown) => {
        if (!cancelled) showError(err);
      });
    return () => {
      cancelled = true;
    };
  }, [showError]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const tenge = Number(fee);
    if (!Number.isFinite(tenge) || tenge < 0) {
      setError(t.admin.invalidFee);
      return;
    }

    setPending(true);
    setSaved(false);
    setError(null);
    try {
      const next = await updateAdminSettings(Math.round(tenge * 100), readToken() ?? '');
      setSettings(next);
      setFee((next.activation_fee / 100).toString());
      setSaved(true);
    } catch (err) {
      showError(err);
    } finally {
      setPending(false);
    }
  }

  return (
    <AdminShell title={t.admin.settingsTitle} intro={t.admin.settingsIntro}>
      {() => (
        <>
          {error ? (
            <p role="alert" className="mt-5 rounded-md bg-red-50 p-3 text-sm text-red-700">
              {error}
            </p>
          ) : null}

          {settings === null && !error ? (
            <p className="mt-6 text-sm text-zinc-600">{t.admin.loading}</p>
          ) : null}

          {settings ? (
            <div className="mt-6 max-w-xl rounded-lg border border-zinc-200 bg-white p-6">
              <p className="text-sm text-zinc-600">
                {fill(t.admin.feeNote, {
                  amount: formatMoney(settings.activation_fee, locale),
                })}
              </p>
              <form onSubmit={submit} className="mt-5">
                <label className="block text-sm font-medium text-zinc-800">
                  {t.admin.feeInTenge}
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    required
                    value={fee}
                    onChange={(event) => {
                      setFee(event.target.value);
                      setSaved(false);
                    }}
                    className={fieldClass}
                  />
                </label>
                <button type="submit" disabled={pending} className={`${buttonClass} mt-4`}>
                  {pending ? t.admin.saving : t.admin.save}
                </button>
                {saved ? <span className="ml-3 text-sm text-green-700">{t.admin.saved}</span> : null}
              </form>
              <p className="mt-4 text-xs text-zinc-500">
                {t.admin.activationFee}: {formatMoney(settings.activation_fee, locale)}
              </p>
            </div>
          ) : null}
        </>
      )}
    </AdminShell>
  );
}
