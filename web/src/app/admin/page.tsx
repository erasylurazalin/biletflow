'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  ApiError,
  downloadAdminCsv,
  formatMoney,
  formatWhen,
  searchAdminEvents,
  searchAdminOrders,
  searchAdminUsers,
  setAdminEventSuspended,
  setAdminUserSuspended,
  type AdminEvent,
  type AdminOrder,
  type AdminUser,
} from '@/api';
import { useI18n } from '@/i18n/client';
import { errorText } from '@/i18n/errors';
import { fill } from '@/i18n/format';
import { clearSession, readToken, useSessionUser } from '@/session';
import { AdminShell } from './admin-shell';

const buttonClass =
  'rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-60';
const smallButtonClass =
  'rounded-md border border-zinc-300 px-2.5 py-1.5 text-sm text-zinc-800 disabled:opacity-60';
const fieldClass =
  'rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-500';

type Tab = 'users' | 'events' | 'orders';

export default function AdminPage() {
  const router = useRouter();
  const { locale, t } = useI18n();
  const me = useSessionUser();
  const [tab, setTab] = useState<Tab>('users');
  const [query, setQuery] = useState('');
  const [committedQuery, setCommittedQuery] = useState('');
  const [status, setStatus] = useState('');
  const [committedStatus, setCommittedStatus] = useState('');
  const [reload, setReload] = useState(0);
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [events, setEvents] = useState<AdminEvent[] | null>(null);
  const [orders, setOrders] = useState<AdminOrder[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string | null>(null);
  const [csvPending, setCsvPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const showError = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) {
        clearSession();
        router.replace('/login?next=/admin');
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
    if (!me || me.role !== 'platform_admin') return;
    let cancelled = false;

    const work =
      tab === 'users'
        ? searchAdminUsers(readToken() ?? '', committedQuery).then((body) => {
            if (!cancelled) setUsers(body.users);
          })
        : tab === 'events'
          ? searchAdminEvents(readToken() ?? '', {
              q: committedQuery,
              status: committedStatus,
            }).then((body) => {
              if (!cancelled) setEvents(body.events);
            })
          : searchAdminOrders(readToken() ?? '', {
              q: committedQuery,
              status: committedStatus,
            }).then((body) => {
              if (!cancelled) setOrders(body.orders);
            });

    work
      .catch((err: unknown) => {
        if (!cancelled) showError(err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [tab, committedQuery, committedStatus, reload, me, showError]);

  function switchTab(next: Tab) {
    setTab(next);
    setQuery('');
    setCommittedQuery('');
    setStatus('');
    setCommittedStatus('');
    setError(null);
    setLoading(true);
  }

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCommittedQuery(query.trim());
    setCommittedStatus(status);
    setLoading(true);
    setReload((value) => value + 1);
  }

  async function toggleUser(user: AdminUser) {
    setPending(`user:${user.id}`);
    setError(null);
    try {
      await setAdminUserSuspended(user.id, !user.suspended, readToken() ?? '');
      setReload((value) => value + 1);
    } catch (err) {
      showError(err);
    } finally {
      setPending(null);
    }
  }

  async function toggleEvent(event: AdminEvent) {
    setPending(`event:${event.id}`);
    setError(null);
    try {
      await setAdminEventSuspended(event.id, !event.suspended, readToken() ?? '');
      setReload((value) => value + 1);
    } catch (err) {
      showError(err);
    } finally {
      setPending(null);
    }
  }

  async function download(kind: 'orders' | 'refunds') {
    setCsvPending(kind);
    setError(null);
    try {
      const blob = await downloadAdminCsv(kind, readToken() ?? '', {
        q: committedQuery,
        status: committedStatus,
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `biletflow-${kind}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      showError(err);
      setError(t.admin.csvError);
    } finally {
      setCsvPending(null);
    }
  }

  return (
    <AdminShell title={t.admin.title} intro={t.admin.intro}>
      {() => (
        <>
          <div role="tablist" className="mt-6 flex flex-wrap gap-2 border-b border-zinc-200">
            {(['users', 'events', 'orders'] as const).map((item) => (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={tab === item}
                onClick={() => switchTab(item)}
                className={`px-3 py-2 text-sm ${
                  tab === item
                    ? 'border-b-2 border-zinc-900 font-medium text-zinc-950'
                    : 'text-zinc-600 hover:text-zinc-900'
                }`}
              >
                {t.admin.tabs[item]}
              </button>
            ))}
          </div>

          <form onSubmit={search} className="mt-5 flex flex-wrap items-center gap-2">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={
                tab === 'users'
                  ? t.admin.searchUsers
                  : tab === 'events'
                    ? t.admin.searchEvents
                    : t.admin.searchOrders
              }
              aria-label={
                tab === 'users'
                  ? t.admin.searchUsers
                  : tab === 'events'
                    ? t.admin.searchEvents
                    : t.admin.searchOrders
              }
              className={`${fieldClass} min-w-64 flex-1`}
            />
            {tab !== 'users' ? (
              <select
                value={status}
                onChange={(event) => setStatus(event.target.value)}
                aria-label={t.admin.status}
                className={fieldClass}
              >
                <option value="">{t.admin.allStatuses}</option>
                {tab === 'events' ? (
                  <>
                    <option value="draft">{t.organizerEvents.draft}</option>
                    <option value="published">{t.organizerEvents.published}</option>
                    <option value="cancelled">{t.organizerEvents.cancelled}</option>
                  </>
                ) : (
                  <>
                    <option value="pending">{t.orderStatus.pending}</option>
                    <option value="paid">{t.orderStatus.paid}</option>
                    <option value="cancelled">{t.orderStatus.cancelled}</option>
                    <option value="refunded">{t.orderStatus.refunded}</option>
                  </>
                )}
              </select>
            ) : null}
            <button type="submit" disabled={loading} className={buttonClass}>
              {loading ? t.admin.loading : t.admin.search}
            </button>
            {tab === 'orders' ? (
              <>
                <button
                  type="button"
                  disabled={csvPending !== null}
                  onClick={() => void download('orders')}
                  className={smallButtonClass}
                >
                  {csvPending === 'orders' ? t.admin.csvPreparing : t.admin.csvOrders}
                </button>
                <button
                  type="button"
                  disabled={csvPending !== null}
                  onClick={() => void download('refunds')}
                  className={smallButtonClass}
                >
                  {csvPending === 'refunds' ? t.admin.csvPreparing : t.admin.csvRefunds}
                </button>
              </>
            ) : null}
          </form>

          {error ? (
            <p role="alert" className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-700">
              {error}
            </p>
          ) : null}

          <div className="mt-6 overflow-x-auto rounded-lg border border-zinc-200 bg-white">
            {tab === 'users' ? (
              <table className="min-w-full divide-y divide-zinc-200 text-sm">
                <thead className="bg-zinc-50 text-left text-xs font-medium text-zinc-600 uppercase">
                  <tr>
                    <th className="px-4 py-3">{t.admin.name}</th>
                    <th className="px-4 py-3">{t.admin.email}</th>
                    <th className="px-4 py-3">{t.admin.role}</th>
                    <th className="px-4 py-3">{t.admin.status}</th>
                    <th className="px-4 py-3">{t.admin.actions}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100">
                  {users?.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-4 py-6 text-zinc-600">
                        {t.admin.usersEmpty}
                      </td>
                    </tr>
                  ) : null}
                  {users?.map((user) => (
                    <tr key={user.id}>
                      <td className="px-4 py-3 font-medium text-zinc-900">{user.name}</td>
                      <td className="px-4 py-3 text-zinc-600">{user.email}</td>
                      <td className="px-4 py-3 text-zinc-600">{user.role}</td>
                      <td className="px-4 py-3 text-zinc-600">
                        {user.suspended ? t.admin.suspended : t.admin.active}
                      </td>
                      <td className="px-4 py-3">
                        {user.suspended || (user.role !== 'platform_admin' && user.id !== me?.id) ? (
                          <button
                            type="button"
                            disabled={pending !== null}
                            onClick={() => void toggleUser(user)}
                            className={smallButtonClass}
                          >
                            {pending === `user:${user.id}`
                              ? t.admin.loading
                              : user.suspended
                                ? t.admin.unsuspend
                                : t.admin.suspend}
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}

            {tab === 'events' ? (
              <table className="min-w-full divide-y divide-zinc-200 text-sm">
                <thead className="bg-zinc-50 text-left text-xs font-medium text-zinc-600 uppercase">
                  <tr>
                    <th className="px-4 py-3">{t.admin.event}</th>
                    <th className="px-4 py-3">{t.admin.organizer}</th>
                    <th className="px-4 py-3">{t.admin.status}</th>
                    <th className="px-4 py-3">{t.admin.openReports}</th>
                    <th className="px-4 py-3">{t.admin.actions}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100">
                  {events?.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-4 py-6 text-zinc-600">
                        {t.admin.eventsEmpty}
                      </td>
                    </tr>
                  ) : null}
                  {events?.map((event) => (
                    <tr key={event.id}>
                      <td className="px-4 py-3">
                        <p className="font-medium text-zinc-900">{event.title}</p>
                        <p className="text-xs text-zinc-500">
                          {formatWhen(event.starts_at, locale)}
                        </p>
                      </td>
                      <td className="px-4 py-3 text-zinc-600">
                        <p>{event.organizer.name}</p>
                        <p className="text-xs text-zinc-500">{event.organizer.email}</p>
                      </td>
                      <td className="px-4 py-3 text-zinc-600">
                        <p>{t.organizerEvents[event.status]}</p>
                        <p className={event.suspended ? 'text-red-700' : 'text-zinc-500'}>
                          {event.suspended ? t.admin.suspended : t.admin.active}
                        </p>
                      </td>
                      <td className="px-4 py-3 text-zinc-600">{event.open_reports}</td>
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          disabled={pending !== null}
                          onClick={() => void toggleEvent(event)}
                          className={smallButtonClass}
                        >
                          {pending === `event:${event.id}`
                            ? t.admin.loading
                            : event.suspended
                              ? t.admin.unsuspend
                              : t.admin.suspend}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}

            {tab === 'orders' ? (
              <table className="min-w-full divide-y divide-zinc-200 text-sm">
                <thead className="bg-zinc-50 text-left text-xs font-medium text-zinc-600 uppercase">
                  <tr>
                    <th className="px-4 py-3">{t.admin.order}</th>
                    <th className="px-4 py-3">{t.admin.buyer}</th>
                    <th className="px-4 py-3">{t.admin.event}</th>
                    <th className="px-4 py-3">{t.admin.status}</th>
                    <th className="px-4 py-3">{t.admin.total}</th>
                    <th className="px-4 py-3">{t.admin.created}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100">
                  {orders?.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-4 py-6 text-zinc-600">
                        {t.admin.ordersEmpty}
                      </td>
                    </tr>
                  ) : null}
                  {orders?.map((order) => (
                    <tr key={order.id}>
                      <td className="px-4 py-3 font-mono text-xs text-zinc-600">
                        {order.id.slice(0, 8)}
                      </td>
                      <td className="px-4 py-3 text-zinc-600">
                        <p>{order.buyer.name}</p>
                        <p className="text-xs text-zinc-500">{order.buyer.email}</p>
                      </td>
                      <td className="px-4 py-3 text-zinc-600">{order.event.title}</td>
                      <td className="px-4 py-3 text-zinc-600">
                        <p>{t.orderStatus[order.status]}</p>
                        {order.refund ? (
                          <p className="text-xs text-zinc-500">
                            {fill(t.organizerOrders.refundedOn, {
                              amount: formatMoney(order.refund.amount, locale),
                              when: formatWhen(order.refund.refunded_at, locale),
                            })}
                          </p>
                        ) : null}
                        {order.failed_payment_attempts > 0 ? (
                          <p className="text-xs text-red-700">
                            {fill(t.admin.failedPayments, {
                              count: order.failed_payment_attempts,
                            })}
                          </p>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 text-zinc-600">
                        {formatMoney(order.total, locale)}
                      </td>
                      <td className="px-4 py-3 text-zinc-600">
                        {formatWhen(order.created_at, locale)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </div>
        </>
      )}
    </AdminShell>
  );
}
