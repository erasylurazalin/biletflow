import Link from 'next/link';
import { formatWhen, listEvents } from '@/mocks';

export default function Home() {
  const events = listEvents();

  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold">Events</h1>
      <ul className="grid gap-4 sm:grid-cols-2">
        {events.map((event) => (
          <li key={event.id}>
            <Link
              href={`/events/${event.id}`}
              className="block overflow-hidden rounded-lg border border-zinc-200 bg-white hover:border-zinc-400"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={event.cover_image_url}
                alt=""
                className="h-40 w-full object-cover"
              />
              <div className="p-4">
                <h2 className="font-medium">{event.title}</h2>
                <p className="mt-1 text-sm text-zinc-600">{event.venue_name}</p>
                <p className="mt-1 text-sm text-zinc-500">{formatWhen(event.starts_at)}</p>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
