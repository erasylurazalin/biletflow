import Link from 'next/link';
import { ApiError, formatWhen, listEvents } from '@/api';
import { ApiUnavailable } from '@/api-unavailable';

export const dynamic = 'force-dynamic';

export default async function Home() {
  let events;
  try {
    events = await listEvents();
  } catch (error) {
    const message =
      error instanceof ApiError
        ? error.message
        : 'Something went wrong loading events.';
    return <ApiUnavailable message={message} />;
  }

  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold">Events</h1>
      {events.length === 0 ? (
        <p className="text-zinc-600">No published events yet.</p>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2">
          {events.map((event) => (
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
                  <p className="mt-1 text-sm text-zinc-500">{formatWhen(event.starts_at)}</p>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
