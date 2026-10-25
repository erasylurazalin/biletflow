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
        setError("Only the event's organizer can see its analytics");
        return;
      }
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
    },
    [loginPath, router],
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
          ← Event
        </Link>
        <Link
          href={`/organizer/events/${eventId}/orders`}
          className="text-zinc-500 hover:text-zinc-800"
        >
          Orders
        </Link>
        <Link
          href={`/organizer/events/${eventId}/staff`}
          className="text-zinc-500 hover:text-zinc-800"
        >
          Staff
        </Link>
        <Link
          href={`/organizer/events/${eventId}/promo`}
          className="text-zinc-500 hover:text-zinc-800"
        >
          Promo codes
        </Link>
      </div>

      <h1 className="mt-4 text-2xl font-semibold">
        Analytics{data ? `: ${data.event.title}` : ''}
      </h1>
      <p className="mt-2 text-sm text-zinc-600">
        Sales, revenue and attendance for this event. All money is simulated demonstration data: no
        real payments or refunds happen.
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
          From
          <input
            type="date"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
            className={fieldClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm text-zinc-700">
          To
          <input
            type="date"
            value={to}
            onChange={(event) => setTo(event.target.value)}
            className={fieldClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm text-zinc-700">
          Ticket type
          <select
            value={ticketTypeId}
            onChange={(event) => setTicketTypeId(event.target.value)}
            className={fieldClass}
          >
            <option value="">Every ticket type</option>
            {types.map((type) => (
              <option key={type.ticket_type_id} value={type.ticket_type_id}>
                {type.name}
                {type.is_hidden ? ' (hidden)' : ''}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={pending} className={buttonClass}>
          {pending ? 'Loading…' : 'Apply'}
        </button>
        {filtered ? (
          <button
            type="button"
            disabled={pending}
            onClick={clear}
            className="rounded-md border border-zinc-300 px-3 py-2 text-sm text-zinc-700 disabled:opacity-60"
          >
            Clear
          </button>
        ) : null}
      </form>

      {!data && !error ? <p className="mt-6 text-sm text-zinc-600">Loading analytics…</p> : null}

      {data ? (
        <>
          {filtered ? (
            <p className="mt-4 text-sm text-zinc-600">
              Showing {data.filters.from ? `orders from ${data.filters.from}` : 'every order'}
              {data.filters.to ? ` up to ${data.filters.to}, not including it` : ''}
              {data.filters.ticket_type_id
                ? ', counted for orders that include the chosen ticket type'
                : ''}
              . Campaign numbers are lifetime figures and do not follow the filter.
            </p>
          ) : null}

          <section aria-labelledby="sales-heading" className="mt-8">
            <h2 id="sales-heading" className="text-lg font-semibold">
              Capacity and sales
            </h2>
            <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-lg border border-zinc-200 bg-white p-4">
                <dt className="text-sm text-zinc-600">Capacity</dt>
                <dd className="mt-1 text-xl font-semibold">{data.sales.capacity}</dd>
              </div>
              <div className="rounded-lg border border-zinc-200 bg-white p-4">
                <dt className="text-sm text-zinc-600">Sold</dt>
                <dd className="mt-1 text-xl font-semibold">{data.sales.sold}</dd>
              </div>
              <div className="rounded-lg border border-zinc-200 bg-white p-4">
                <dt className="text-sm text-zinc-600">Remaining</dt>
                <dd className="mt-1 text-xl font-semibold">{data.sales.remaining}</dd>
              </div>
              <div className="rounded-lg border border-zinc-200 bg-white p-4">
                <dt className="text-sm text-zinc-600">Sold, percent</dt>
                <dd className="mt-1 text-xl font-semibold">{data.sales.percent_sold}%</dd>
              </div>
            </dl>
            <p className="mt-2 text-sm text-zinc-600">
              {data.sales.held === 1
                ? '1 seat is held by an unpaid order that has not expired.'
                : `${data.sales.held} seats are held by unpaid orders that have not expired.`}
            </p>
          </section>

          <section aria-labelledby="revenue-heading" className="mt-8">
            <h2 id="revenue-heading" className="text-lg font-semibold">
              Revenue (simulated)
            </h2>
            <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-lg border border-zinc-200 bg-white p-4">
                <dt className="text-sm text-zinc-600">Gross sales</dt>
                <dd className="mt-1 text-xl font-semibold">{formatMoney(data.revenue.gross)}</dd>
              </div>
              <div className="rounded-lg border border-zinc-200 bg-white p-4">
                <dt className="text-sm text-zinc-600">Discounts</dt>
                <dd className="mt-1 text-xl font-semibold">
                  {formatMoney(data.revenue.discounts)}
                </dd>
              </div>
              <div className="rounded-lg border border-zinc-200 bg-white p-4">
                <dt className="text-sm text-zinc-600">Refunds</dt>
                <dd className="mt-1 text-xl font-semibold">{formatMoney(data.revenue.refunds)}</dd>
              </div>
              <div className="rounded-lg border border-zinc-200 bg-white p-4">
                <dt className="text-sm text-zinc-600">Net revenue</dt>
                <dd className="mt-1 text-xl font-semibold">{formatMoney(data.revenue.net)}</dd>
              </div>
            </dl>
            <p className="mt-2 text-sm text-zinc-600">
              The 3% processing charge is paid by the attendee and is not organizer revenue, so it
              is in none of these figures.
            </p>
          </section>

          <section aria-labelledby="attendance-heading" className="mt-8">
            <h2 id="attendance-heading" className="text-lg font-semibold">
              Attendance
            </h2>
            <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-lg border border-zinc-200 bg-white p-4">
                <dt className="text-sm text-zinc-600">Tickets</dt>
                <dd className="mt-1 text-xl font-semibold">{data.check_in.registered}</dd>
              </div>
              <div className="rounded-lg border border-zinc-200 bg-white p-4">
                <dt className="text-sm text-zinc-600">Checked in</dt>
                <dd className="mt-1 text-xl font-semibold">{data.check_in.checked_in}</dd>
              </div>
              <div className="rounded-lg border border-zinc-200 bg-white p-4">
                <dt className="text-sm text-zinc-600">Absent</dt>
                <dd className="mt-1 text-xl font-semibold">{data.check_in.absent}</dd>
              </div>
              <div className="rounded-lg border border-zinc-200 bg-white p-4">
                <dt className="text-sm text-zinc-600">Checked in, percent</dt>
                <dd className="mt-1 text-xl font-semibold">{data.check_in.percent}%</dd>
              </div>
            </dl>
          </section>

          <section aria-labelledby="types-heading" className="mt-8">
            <h2 id="types-heading" className="text-lg font-semibold">
              By ticket type
            </h2>
            <div className="mt-3 overflow-x-auto rounded-lg border border-zinc-200 bg-white">
              <table className="w-full text-left text-sm">
                <thead className="bg-zinc-50 text-zinc-600">
                  <tr>
                    <th scope="col" className="px-4 py-2 font-medium">
                      Ticket type
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      Capacity
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      Sold
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      Remaining
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      Gross
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      Checked in
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      Absent
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-200">
                  {data.by_ticket_type.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-4 py-3 text-zinc-600">
                        This event has no ticket types yet.
                      </td>
                    </tr>
                  ) : null}
                  {data.by_ticket_type.map((type) => (
                    <tr key={type.ticket_type_id}>
                      <td className="px-4 py-2">
                        {type.name}
                        {type.is_hidden ? (
                          <span className="ml-2 text-xs text-zinc-500">hidden</span>
                        ) : null}
                      </td>
                      <td className="px-4 py-2">{type.capacity}</td>
                      <td className="px-4 py-2">{type.sold}</td>
                      <td className="px-4 py-2">{type.remaining}</td>
                      <td className="px-4 py-2">{formatMoney(type.gross)}</td>
                      <td className="px-4 py-2">{type.checked_in}</td>
                      <td className="px-4 py-2">{type.absent}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-sm text-zinc-600">
              Gross here is before discounts: a discount is recorded for the whole order, so it is
              not split between ticket types.
            </p>
          </section>

          <section aria-labelledby="time-heading" className="mt-8">
            <h2 id="time-heading" className="text-lg font-semibold">
              Sales over time
            </h2>
            <div className="mt-3 overflow-x-auto rounded-lg border border-zinc-200 bg-white">
              <table className="w-full text-left text-sm">
                <thead className="bg-zinc-50 text-zinc-600">
                  <tr>
                    <th scope="col" className="px-4 py-2 font-medium">
                      Day
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      Orders
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      Tickets
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      Gross
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      Net
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-200">
                  {data.over_time.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-4 py-3 text-zinc-600">
                        No orders in this period.
                      </td>
                    </tr>
                  ) : null}
                  {data.over_time.map((day) => (
                    <tr key={day.date}>
                      <td className="px-4 py-2">{day.date}</td>
                      <td className="px-4 py-2">{day.orders}</td>
                      <td className="px-4 py-2">{day.tickets}</td>
                      <td className="px-4 py-2">{formatMoney(day.gross)}</td>
                      <td className="px-4 py-2">{formatMoney(day.net)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-sm text-zinc-600">
              Days follow Kazakhstan time. Refunds are not shown by day, because a refund happens on
              a different day than the sale; they are in the revenue figures above.
            </p>
          </section>

          <section aria-labelledby="campaigns-heading" className="mt-8">
            <h2 id="campaigns-heading" className="text-lg font-semibold">
              Campaigns
            </h2>
            {data.campaigns.length === 0 ? (
              <p className="mt-3 text-sm text-zinc-600">
                {filtered
                  ? 'No promo campaigns cover the ticket type in this filter.'
                  : 'This event has no promo campaigns yet.'}
              </p>
            ) : (
              <ul className="mt-3 divide-y divide-zinc-200 rounded-lg border border-zinc-200 bg-white px-5">
                {data.campaigns.map((campaign) => (
                  <li key={campaign.id} className="py-4">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <p className="text-sm font-medium text-zinc-900">{campaign.name}</p>
                        <p className="mt-1 text-sm text-zinc-600">
                          Code {campaign.code}
                          {campaign.is_active ? '' : ' (switched off)'}
                        </p>
                      </div>
                      <p className="text-sm text-zinc-600">
                        {campaign.redemptions}{' '}
                        {campaign.redemptions === 1 ? 'redemption' : 'redemptions'}
                      </p>
                    </div>
                    <p className="mt-2 text-sm text-zinc-600">
                      {campaign.orders} {campaign.orders === 1 ? 'order' : 'orders'},{' '}
                      {campaign.tickets_sold} {campaign.tickets_sold === 1 ? 'ticket' : 'tickets'},
                      gross {formatMoney(campaign.gross_revenue)}, discounts{' '}
                      {formatMoney(campaign.discount_total)}, net{' '}
                      {formatMoney(campaign.net_revenue)}
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
  return (
    <Suspense fallback={<p className="text-sm text-zinc-600">Loading analytics…</p>}>
      <EventAnalyticsPage />
    </Suspense>
  );
}
