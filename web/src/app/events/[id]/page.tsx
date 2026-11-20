import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiError, formatWhen, getEvent, getPromoByToken, type PromoInfo } from '@/api';
import { ApiUnavailable } from '@/api-unavailable';
import { errorText } from '@/i18n/errors';
import { fill } from '@/i18n/format';
import { getI18n } from '@/i18n/server';
import { TicketPicker } from '@/ticket-picker';

export const dynamic = 'force-dynamic';

export default async function EventPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ promo?: string }>;
}) {
  const { id } = await params;
  const { locale, t } = await getI18n();
  const { promo: promoToken } = await searchParams;

  // A campaign link (?promo=<token>) fills the promo field. A dead or foreign link is
  // just ignored: the page still shows the event without a code.
  let promo: PromoInfo | null = null;
  if (promoToken) {
    try {
      const fetched = await getPromoByToken(promoToken);
      if (fetched.event_id === id) {
        promo = fetched;
      }
    } catch {
      promo = null;
    }
  }

  let event;
  try {
    event = await getEvent(id);
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 400)) {
      event = undefined;
    } else {
      const message = error instanceof ApiError ? errorText(error, t) : t.event.loadError;
      return <ApiUnavailable message={message} />;
    }
  }

  if (!event) notFound();

  return (
    <div>
      <Link href="/" className="text-sm text-zinc-500 hover:text-zinc-800">
        {t.event.back}
      </Link>
      {event.cover_image_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={event.cover_image_url}
          alt=""
          className="mt-4 h-56 w-full rounded-lg object-cover"
        />
      ) : (
        <div className="mt-4 h-56 w-full rounded-lg bg-zinc-200" />
      )}
      <h1 className="mt-6 text-3xl font-semibold">{event.title}</h1>
      <p className="mt-2 text-zinc-600">
        {event.venue_name} · {event.venue_address}
      </p>
      <p className="mt-1 text-sm text-zinc-500">
        {formatWhen(event.starts_at, locale)} — {formatWhen(event.ends_at, locale)}
      </p>
      <p className="mt-4 max-w-2xl text-zinc-700">{event.description}</p>
      {event.refund_policy ? (
        <section className="mt-4 max-w-2xl">
          <h2 className="text-sm font-medium text-zinc-800">{t.event.refundPolicy}</h2>
          <p className="mt-1 text-sm text-zinc-600">{event.refund_policy}</p>
        </section>
      ) : null}
      <p className="mt-2 text-sm text-zinc-500">{fill(t.event.organizer, { name: event.organizer.name })}</p>

      <h2 className="mt-8 mb-3 text-xl font-medium">{t.event.tickets}</h2>
      {event.ticket_types.length === 0 && !promo ? (
        <p className="text-zinc-600">{t.event.noTickets}</p>
      ) : (
        <TicketPicker
          eventId={event.id}
          ticketTypes={event.ticket_types}
          paidSalesActive={event.paid_sales_active}
          promo={promo}
        />
      )}
    </div>
  );
}
