export function ApiUnavailable({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-6">
      <h1 className="text-lg font-medium">The events API is unavailable</h1>
      <p className="mt-2 max-w-xl text-sm text-zinc-600">{message}</p>
    </div>
  );
}
