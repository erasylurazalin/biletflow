'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  formatWhen,
  listAdminReports,
  resolveAdminReport,
  type AdminReport,
} from '@/api';
import { useI18n } from '@/i18n/client';
import { errorText } from '@/i18n/errors';
import { clearSession, readToken } from '@/session';
import { AdminShell } from '../admin-shell';

const buttonClass =
  'rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-800 disabled:opacity-60';
const suspendButtonClass =
  'rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60';

export default function AdminReportsPage() {
  const router = useRouter();
  const { locale, t } = useI18n();
  const [reports, setReports] = useState<AdminReport[] | null>(null);
  const [reload, setReload] = useState(0);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const showError = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) {
        clearSession();
        router.replace('/login?next=/admin/reports');
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
    listAdminReports(readToken() ?? '', 'open')
      .then((next) => {
        if (!cancelled) setReports(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) showError(err);
      });
    return () => {
      cancelled = true;
    };
  }, [reload, showError]);

  async function resolve(report: AdminReport, action: 'dismiss' | 'suspend') {
    setPending(`${action}:${report.id}`);
    setError(null);
    try {
      await resolveAdminReport(report.id, action, readToken() ?? '');
      setReload((value) => value + 1);
    } catch (err) {
      showError(err);
    } finally {
      setPending(null);
    }
  }

  return (
    <AdminShell title={t.admin.reportsTitle} intro={t.admin.reportsIntro}>
      {() => (
        <>
          {error ? (
            <p role="alert" className="mt-5 rounded-md bg-red-50 p-3 text-sm text-red-700">
              {error}
            </p>
          ) : null}

          {reports === null && !error ? (
            <p className="mt-6 text-sm text-zinc-600">{t.admin.loading}</p>
          ) : null}

          {reports?.length === 0 ? (
            <p className="mt-6 rounded-lg border border-zinc-200 bg-white p-5 text-sm text-zinc-600">
              {t.admin.reportsEmpty}
            </p>
          ) : null}

          {reports && reports.length > 0 ? (
            <ul className="mt-6 divide-y divide-zinc-200 rounded-lg border border-zinc-200 bg-white">
              {reports.map((report) => (
                <li key={report.id} className="p-5">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="font-medium text-zinc-900">{report.event.title}</p>
                      <p className="mt-1 text-sm text-zinc-600">{report.reason}</p>
                      <p className="mt-2 text-xs text-zinc-500">
                        {report.reported_by.name} ({report.reported_by.email}) ·{' '}
                        {formatWhen(report.created_at, locale)}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <button
                        type="button"
                        disabled={pending !== null}
                        onClick={() => void resolve(report, 'dismiss')}
                        className={buttonClass}
                      >
                        {pending === `dismiss:${report.id}` ? t.admin.loading : t.admin.dismiss}
                      </button>
                      <button
                        type="button"
                        disabled={pending !== null}
                        onClick={() => void resolve(report, 'suspend')}
                        className={suspendButtonClass}
                      >
                        {pending === `suspend:${report.id}`
                          ? t.admin.loading
                          : t.admin.suspendEvent}
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </AdminShell>
  );
}
