import Link from 'next/link';
import { notFound } from 'next/navigation';
import { formatPrice, formatWhen, getEvent } from '@/mocks';

export default async function EventPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const event = getEvent(id);
  if (!event) notFound();

  return (
    <div>
      <Link href="/" className="text-sm text-zinc-500 hover:text-zinc-800">
        ← Events
      </Link>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={event.cover_image_url}
        alt=""
        className="mt-4 h-56 w-full rounded-lg object-cover"
      />
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
    </div>
  );
}
