import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiError, formatPrice, formatWhen, getEvent } from '@/api';
import { ApiUnavailable } from '@/api-unavailable';

export const dynamic = 'force-dynamic';

export default async function EventPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let event;
  try {
    event = await getEvent(id);
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 400)) {
      event = undefined;
    } else {
      const message =
        error instanceof ApiError
          ? error.message
          : 'Something went wrong loading this event.';
      return <ApiUnavailable message={message} />;
    }
  }

  if (!event) notFound();

  return (
    <div>
      <Link href="/" className="text-sm text-zinc-500 hover:text-zinc-800">
        ← Events
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
        {formatWhen(event.starts_at)} — {formatWhen(event.ends_at)}
      </p>
      <p className="mt-4 max-w-2xl text-zinc-700">{event.description}</p>
      <p className="mt-2 text-sm text-zinc-500">Organizer: {event.organizer.name}</p>

      <h2 className="mt-8 mb-3 text-xl font-medium">Tickets</h2>
      {event.ticket_types.length === 0 ? (
        <p className="text-zinc-600">No tickets on sale.</p>
      ) : (
        <ul className="space-y-3">
          {event.ticket_types.map((ticket) => (
            <li
              key={ticket.id}
              className="flex items-center justify-between rounded-lg border border-zinc-200 bg-white p-4"
            >
              <div>
                <div className="font-medium">{ticket.name}</div>
                <div className="text-sm text-zinc-500">
                  {ticket.quantity_available} of {ticket.quantity_total} left
                </div>
              </div>
              <div className="text-right">
                <div className="font-medium">{formatPrice(ticket.price)}</div>
                <button
                  type="button"
                  disabled
                  className="mt-1 rounded bg-zinc-200 px-3 py-1 text-sm text-zinc-500"
                >
                  Buy (soon)
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
