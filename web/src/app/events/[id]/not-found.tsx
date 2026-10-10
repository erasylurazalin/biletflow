import Link from 'next/link';

export default function EventNotFound() {
  return (
    <div>
      <h1 className="text-2xl font-semibold">Event not found</h1>
      <p className="mt-2 text-zinc-600">That event is not published, or the link is wrong.</p>
      <Link href="/" className="mt-4 inline-block text-sm text-zinc-500 hover:text-zinc-800">
        ← Events
      </Link>
    </div>
  );
}
