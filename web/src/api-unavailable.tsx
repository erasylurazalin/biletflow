import { getI18n } from '@/i18n/server';

export async function ApiUnavailable({ message }: { message: string }) {
  const { t } = await getI18n();
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-6">
      <h1 className="text-lg font-medium">{t.home.unavailable}</h1>
      <p className="mt-2 max-w-xl text-sm text-zinc-600">{message}</p>
    </div>
  );
}
