import Link from 'next/link';
import {
  ApiError,
  formatWhen,
  listEvents,
  type EventSearchFilters,
} from '@/api';
import { ApiUnavailable } from '@/api-unavailable';
import { errorText } from '@/i18n/errors';
import { plural } from '@/i18n/format';
import { getI18n } from '@/i18n/server';

export const dynamic = 'force-dynamic';

type HomeSearchParams = {
  q?: string | string[];
  from?: string | string[];
  to?: string | string[];
  free?: string | string[];
};

// A shared link may repeat a key. The form never does, so the first value is enough.
function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const fieldClass =
  'mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-500';
const labelClass = 'block min-w-0 flex-1 basis-56 text-sm font-medium';
const buttonClass = 'rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white';
const clearClass = 'text-sm text-zinc-600 hover:underline';

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<HomeSearchParams>;
}) {
  const { locale, t } = await getI18n();
  const params = await searchParams;
  const q = first(params.q)?.trim() || undefined;
  const from = first(params.from) || undefined;
  const to = first(params.to) || undefined;
  const free = first(params.free) === 'true';
  const filters: EventSearchFilters = { q, from, to, free };
  const hasFilters = Boolean(q || from || to || free);

  let result;
  try {
    result = await listEvents(filters);
  } catch (error) {
    const message = error instanceof ApiError ? errorText(error, t) : t.home.loadError;
    return <ApiUnavailable message={message} />;
  }

  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold">{t.home.title}</h1>

      {/* A plain GET form: the URL carries the filters and works without JavaScript. */}
      <form method="get" action="/" className="mb-6 rounded-lg border border-zinc-200 bg-white p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className={labelClass}>
            <span>{t.search.qLabel}</span>
            <input
              type="search"
              name="q"
              defaultValue={q ?? ''}
              maxLength={100}
              placeholder={t.search.placeholder}
              className={fieldClass}
            />
          </label>
          <label className="block min-w-0 flex-1 basis-40 text-sm font-medium">
            <span>{t.search.from}</span>
            <input type="date" name="from" defaultValue={from ?? ''} className={fieldClass} />
          </label>
          <label className="block min-w-0 flex-1 basis-40 text-sm font-medium">
            <span>{t.search.to}</span>
            <input type="date" name="to" defaultValue={to ?? ''} className={fieldClass} />
          </label>
          <label className="flex min-h-10 items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              name="free"
              value="true"
              defaultChecked={free}
              className="h-4 w-4 rounded border-zinc-300"
            />
            {t.search.freeOnly}
          </label>
          <div className="flex items-center gap-4 pb-1">
            <button type="submit" className={buttonClass}>
              {t.search.submit}
            </button>
            <Link href="/" className={clearClass}>
              {t.search.clear}
            </Link>
          </div>
        </div>
      </form>

      {hasFilters ? (
        <p role="status" className="mb-4 text-sm text-zinc-600">
          {plural(locale, t.search.results, result.total)}
        </p>
      ) : null}

      {result.events.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 bg-white p-6">
          <p className="text-zinc-600">{hasFilters ? t.search.noMatches : t.home.empty}</p>
          {hasFilters ? (
            <Link href="/" className={`${clearClass} mt-2 inline-block`}>
              {t.search.clear}
            </Link>
          ) : null}
        </div>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2">
          {result.events.map((event) => (
            <li key={event.id}>
              <Link
                href={`/events/${event.id}`}
                className="block overflow-hidden rounded-lg border border-zinc-200 bg-white hover:border-zinc-400"
              >
                {event.cover_image_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={event.cover_image_url}
                    alt=""
                    className="h-40 w-full object-cover"
                  />
                ) : (
                  <div className="h-40 w-full bg-zinc-200" />
                )}
                <div className="p-4">
                  <h2 className="font-medium">{event.title}</h2>
                  <p className="mt-1 text-sm text-zinc-600">{event.venue_name}</p>
                  <p className="mt-1 text-sm text-zinc-500">{formatWhen(event.starts_at, locale)}</p>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
