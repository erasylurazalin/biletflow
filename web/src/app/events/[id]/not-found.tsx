import Link from 'next/link';
import { getI18n } from '@/i18n/server';

export default async function EventNotFound() {
  const { t } = await getI18n();
  return (
    <div>
      <h1 className="text-2xl font-semibold">{t.event.notFoundTitle}</h1>
      <p className="mt-2 text-zinc-600">{t.event.notFoundText}</p>
      <Link href="/" className="mt-4 inline-block text-sm text-zinc-500 hover:text-zinc-800">
        {t.event.back}
      </Link>
    </div>
  );
}
