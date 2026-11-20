'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  formatMoney,
  getEventAnalytics,
  type AnalyticsFilters,
  type EventAnalytics,
} from '@/api';
import { useI18n } from '@/i18n/client';
import { errorText } from '@/i18n/errors';
import { fill, plural } from '@/i18n/format';
import { clearSession, readToken } from '@/session';

const buttonClass =
  'rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-60';
const fieldClass =
  'rounded-md border border-zinc-300 px-3 py-2 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-400';

// The event dashboard (SRS 4.15, UC11, criterion 10). Every number is computed by the
// API from orders, tickets, refunds and check-ins; this page only presents them.
// Revenue is demonstration money and is labelled as such, like every other simulated
// amount in the product (SRS 4.6).
function EventAnalyticsPage() {
  const { id: eventId } = useParams<{ id: string }>();
  const router = useRouter();
  const { locale, t } = useI18n();
  const [data, setData] = useState<EventAnalytics | null>(null);
  const [types, setTypes] = useState<EventAnalytics['by_ticket_type']>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // What the inputs hold, which is not what was last asked for until Apply is pressed.
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [ticketTypeId, setTicketTypeId] = useState('');
  const loginPath = `/login?next=${encodeURIComponent(`/organizer/events/${eventId}/analytics`)}`;

  const showError = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) {
        clearSession();
        router.replace(loginPath);
        return;
      }
      if (err instanceof ApiError && err.status === 403) {
        setError(t.analytics.ownerOnly);
        return;
      }
      setError(errorText(err, t));
    },
    [loginPath, router, t],
  );

  // The buttons fetch through this, and the first load does the same inline below, the
  // way the other organizer pages are written.
  const load = useCallback(
    async (filters: AnalyticsFilters) => {
      const token = readToken();
      if (!token) {
        router.replace(loginPath);
        return;
      }
      try {
        const next = await getEventAnalytics(eventId, token, filters);
        setData(next);
        // The type picker offers every type of the event, so it is filled from an
        // unfiltered answer and then left alone while a filter is on.
        if (!filters.ticket_type_id) {
          setTypes(next.by_ticket_type);
        }
        setError(null);
      } catch (err) {
        showError(err);
      }
    },
    [eventId, loginPath, router, showError],
  );

  useEffect(() => {
    const token = readToken();
    if (!token) {
      router.replace(loginPath);
      return;
    }
    getEventAnalytics(eventId, token)
      .then((next) => {
        setData(next);
        setTypes(next.by_ticket_type);
        setError(null);
      })
      .catch((err: unknown) => showError(err));
  }, [eventId, loginPath, router, showError]);

  function apply(): void {
    const filters: AnalyticsFilters = {};
    if (from) filters.from = from;
    if (to) filters.to = to;
    if (ticketTypeId) filters.ticket_type_id = ticketTypeId;
    setPending(true);
    void load(filters).finally(() => setPending(false));
  }

  function clear(): void {
    setFrom('');
    setTo('');
    setTicketTypeId('');
    setPending(true);
    void load({}).finally(() => setPending(false));
  }

  const filtered = Boolean(from || to || ticketTypeId);

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <Link href={`/events/${eventId}`} className="text-zinc-500 hover:text-zinc-800">
          {t.organizer.back}
        </Link>
        <Link
          href={`/organizer/events/${eventId}/orders`}
          className="text-zinc-500 hover:text-zinc-800"
        >
          {t.organizer.orders}
        </Link>
        <Link
          href={`/organizer/events/${eventId}/staff`}
          className="text-zinc-500 hover:text-zinc-800"
        >
          {t.organizer.staff}
        </Link>
        <Link
          href={`/organizer/events/${eventId}/promo`}
          className="text-zinc-500 hover:text-zinc-800"
        >
          {t.organizer.promoCodes}
        </Link>
      </div>

      <h1 className="mt-4 text-2xl font-semibold">
        {data ? fill(t.analytics.titleWithEvent, { event: data.event.title }) : t.analytics.title}
      </h1>
      <p className="mt-2 text-sm text-zinc-600">
        {t.analytics.intro}
      </p>

      {error ? (
        <p role="alert" className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      <form
        className="mt-6 flex flex-wrap items-end gap-3 rounded-lg border border-zinc-200 bg-white p-4"
        onSubmit={(event) => {
          event.preventDefault();
          apply();
        }}
      >
        <label className="flex flex-col gap-1 text-sm text-zinc-700">
          {t.analytics.from}
          <input
            type="date"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
            className={fieldClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm text-zinc-700">
          {t.analytics.to}
          <input
            type="date"
            value={to}
            onChange={(event) => setTo(event.target.value)}
            className={fieldClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm text-zinc-700">
          {t.analytics.ticketType}
          <select
            value={ticketTypeId}
            onChange={(event) => setTicketTypeId(event.target.value)}
            className={fieldClass}
          >
            <option value="">{t.analytics.everyTicketType}</option>
            {types.map((type) => (
              <option key={type.ticket_type_id} value={type.ticket_type_id}>
                {type.name}
                {type.is_hidden ? ` (${t.organizer.hidden})` : ''}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={pending} className={buttonClass}>
          {pending ? t.common.loading : t.analytics.apply}
        </button>
        {filtered ? (
          <button
            type="button"
            disabled={pending}
            onClick={clear}
            className="rounded-md border border-zinc-300 px-3 py-2 text-sm text-zinc-700 disabled:opacity-60"
          >
            {t.analytics.clear}
          </button>
        ) : null}
      </form>

      {!data && !error ? <p className="mt-6 text-sm text-zinc-600">{t.analytics.loading}</p> : null}

      {data ? (
        <>
          {filtered ? (
            <p className="mt-4 text-sm text-zinc-600">
              {fill(t.analytics.showing, {
                range: fill(
                  data.filters.from && data.filters.to
                    ? t.analytics.rangeFromTo
                    : data.filters.from
                      ? t.analytics.rangeFrom
                      : data.filters.to
                        ? t.analytics.rangeTo
                        : t.analytics.rangeAll,
                  { from: data.filters.from ?? '', to: data.filters.to ?? '' },
                ),
                type: data.filters.ticket_type_id ? t.analytics.typeNote : '',
              })}
            </p>
          ) : null}

          <section aria-labelledby="sales-heading" className="mt-8">
            <h2 id="sales-heading" className="text-lg font-semibold">
              {t.analytics.sales}
            </h2>
            <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-lg border border-zinc-200 bg-white p-4">
                <dt className="text-sm text-zinc-600">{t.analytics.capacity}</dt>
                <dd className="mt-1 text-xl font-semibold">{data.sales.capacity}</dd>
              </div>
              <div className="rounded-lg border border-zinc-200 bg-white p-4">
                <dt className="text-sm text-zinc-600">{t.analytics.sold}</dt>
                <dd className="mt-1 text-xl font-semibold">{data.sales.sold}</dd>
              </div>
              <div className="rounded-lg border border-zinc-200 bg-white p-4">
                <dt className="text-sm text-zinc-600">{t.analytics.remaining}</dt>
                <dd className="mt-1 text-xl font-semibold">{data.sales.remaining}</dd>
              </div>
              <div className="rounded-lg border border-zinc-200 bg-white p-4">
                <dt className="text-sm text-zinc-600">{t.analytics.percentSold}</dt>
                <dd className="mt-1 text-xl font-semibold">{data.sales.percent_sold}%</dd>
              </div>
            </dl>
            <p className="mt-2 text-sm text-zinc-600">
              {plural(locale, t.analytics.held, data.sales.held)}
            </p>
          </section>

          <section aria-labelledby="revenue-heading" className="mt-8">
            <h2 id="revenue-heading" className="text-lg font-semibold">
              {t.analytics.revenue}
            </h2>
            <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-lg border border-zinc-200 bg-white p-4">
                <dt className="text-sm text-zinc-600">{t.analytics.grossSales}</dt>
                <dd className="mt-1 text-xl font-semibold">{formatMoney(data.revenue.gross, locale)}</dd>
              </div>
              <div className="rounded-lg border border-zinc-200 bg-white p-4">
                <dt className="text-sm text-zinc-600">{t.analytics.discounts}</dt>
                <dd className="mt-1 text-xl font-semibold">
                  {formatMoney(data.revenue.discounts, locale)}
                </dd>
              </div>
              <div className="rounded-lg border border-zinc-200 bg-white p-4">
                <dt className="text-sm text-zinc-600">{t.analytics.refunds}</dt>
                <dd className="mt-1 text-xl font-semibold">{formatMoney(data.revenue.refunds, locale)}</dd>
              </div>
              <div className="rounded-lg border border-zinc-200 bg-white p-4">
                <dt className="text-sm text-zinc-600">{t.analytics.netRevenue}</dt>
                <dd className="mt-1 text-xl font-semibold">{formatMoney(data.revenue.net, locale)}</dd>
              </div>
            </dl>
            <p className="mt-2 text-sm text-zinc-600">
              {t.analytics.feeNote}
            </p>
          </section>

          <section aria-labelledby="attendance-heading" className="mt-8">
            <h2 id="attendance-heading" className="text-lg font-semibold">
              {t.analytics.attendance}
            </h2>
            <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-lg border border-zinc-200 bg-white p-4">
                <dt className="text-sm text-zinc-600">{t.analytics.tickets}</dt>
                <dd className="mt-1 text-xl font-semibold">{data.check_in.registered}</dd>
              </div>
              <div className="rounded-lg border border-zinc-200 bg-white p-4">
                <dt className="text-sm text-zinc-600">{t.analytics.checkedIn}</dt>
                <dd className="mt-1 text-xl font-semibold">{data.check_in.checked_in}</dd>
              </div>
              <div className="rounded-lg border border-zinc-200 bg-white p-4">
                <dt className="text-sm text-zinc-600">{t.analytics.absent}</dt>
                <dd className="mt-1 text-xl font-semibold">{data.check_in.absent}</dd>
              </div>
              <div className="rounded-lg border border-zinc-200 bg-white p-4">
                <dt className="text-sm text-zinc-600">{t.analytics.percentCheckedIn}</dt>
                <dd className="mt-1 text-xl font-semibold">{data.check_in.percent}%</dd>
              </div>
            </dl>
          </section>

          <section aria-labelledby="types-heading" className="mt-8">
            <h2 id="types-heading" className="text-lg font-semibold">
              {t.analytics.byType}
            </h2>
            <div className="mt-3 overflow-x-auto rounded-lg border border-zinc-200 bg-white">
              <table className="w-full text-left text-sm">
                <thead className="bg-zinc-50 text-zinc-600">
                  <tr>
                    <th scope="col" className="px-4 py-2 font-medium">
                      {t.analytics.ticketType}
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      {t.analytics.capacity}
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      {t.analytics.sold}
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      {t.analytics.remaining}
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      {t.analytics.gross}
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      {t.analytics.checkedIn}
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      {t.analytics.absent}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-200">
                  {data.by_ticket_type.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-4 py-3 text-zinc-600">
                        {t.organizer.noTicketTypes}
                      </td>
                    </tr>
                  ) : null}
                  {data.by_ticket_type.map((type) => (
                    <tr key={type.ticket_type_id}>
                      <td className="px-4 py-2">
                        {type.name}
                        {type.is_hidden ? (
                          <span className="ml-2 text-xs text-zinc-500">{t.organizer.hidden}</span>
                        ) : null}
                      </td>
                      <td className="px-4 py-2">{type.capacity}</td>
                      <td className="px-4 py-2">{type.sold}</td>
                      <td className="px-4 py-2">{type.remaining}</td>
                      <td className="px-4 py-2">{formatMoney(type.gross, locale)}</td>
                      <td className="px-4 py-2">{type.checked_in}</td>
                      <td className="px-4 py-2">{type.absent}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-sm text-zinc-600">
              {t.analytics.byTypeNote}
            </p>
          </section>

          <section aria-labelledby="time-heading" className="mt-8">
            <h2 id="time-heading" className="text-lg font-semibold">
              {t.analytics.overTime}
            </h2>
            <div className="mt-3 overflow-x-auto rounded-lg border border-zinc-200 bg-white">
              <table className="w-full text-left text-sm">
                <thead className="bg-zinc-50 text-zinc-600">
                  <tr>
                    <th scope="col" className="px-4 py-2 font-medium">
                      {t.analytics.day}
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      {t.analytics.orders}
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      {t.analytics.tickets}
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      {t.analytics.gross}
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      {t.analytics.net}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-200">
                  {data.over_time.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-4 py-3 text-zinc-600">
                        {t.analytics.noOrders}
                      </td>
                    </tr>
                  ) : null}
                  {data.over_time.map((day) => (
                    <tr key={day.date}>
                      <td className="px-4 py-2">{day.date}</td>
                      <td className="px-4 py-2">{day.orders}</td>
                      <td className="px-4 py-2">{day.tickets}</td>
                      <td className="px-4 py-2">{formatMoney(day.gross, locale)}</td>
                      <td className="px-4 py-2">{formatMoney(day.net, locale)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-sm text-zinc-600">
              {t.analytics.overTimeNote}
            </p>
          </section>

          <section aria-labelledby="campaigns-heading" className="mt-8">
            <h2 id="campaigns-heading" className="text-lg font-semibold">
              {t.analytics.campaigns}
            </h2>
            {data.campaigns.length === 0 ? (
              <p className="mt-3 text-sm text-zinc-600">
                {filtered ? t.analytics.noCampaignsFiltered : t.analytics.noCampaigns}
              </p>
            ) : (
              <ul className="mt-3 divide-y divide-zinc-200 rounded-lg border border-zinc-200 bg-white px-5">
                {data.campaigns.map((campaign) => (
                  <li key={campaign.id} className="py-4">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <p className="text-sm font-medium text-zinc-900">{campaign.name}</p>
                        <p className="mt-1 text-sm text-zinc-600">
                          {fill(t.analytics.code, { code: campaign.code })}
                          {campaign.is_active ? '' : t.analytics.switchedOff}
                        </p>
                      </div>
                      <p className="text-sm text-zinc-600">
                        {plural(locale, t.analytics.redemptions, campaign.redemptions)}
                      </p>
                    </div>
                    <p className="mt-2 text-sm text-zinc-600">
                      {fill(t.analytics.campaignReport, {
                        orders: plural(locale, t.organizer.orderCount, campaign.orders),
                        tickets: plural(locale, t.organizer.ticketCount, campaign.tickets_sold),
                        gross: formatMoney(campaign.gross_revenue, locale),
                        discounts: formatMoney(campaign.discount_total, locale),
                        net: formatMoney(campaign.net_revenue, locale),
                      })}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}

export default function EventAnalyticsRoute() {
  const { t } = useI18n();
  return (
    <Suspense fallback={<p className="text-sm text-zinc-600">{t.analytics.loading}</p>}>
      <EventAnalyticsPage />
    </Suspense>
  );
}
