// The locale for server components: the cookie the language switch writes, else the
// browser's Accept-Language, else Kazakh.
import { cookies, headers } from 'next/headers';
import { DEFAULT_LOCALE, LOCALE_COOKIE, isLocale, type Locale } from './config';
import { dictionaries, type Dictionary } from './index';

function fromAcceptLanguage(header: string | null): Locale | null {
  for (const part of (header ?? '').split(',')) {
    // "ru-RU;q=0.9" -> "ru"
    const primary = part.split(';')[0]?.trim().split('-')[0]?.toLowerCase();
    if (isLocale(primary)) return primary;
  }
  return null;
}

export async function getLocale(): Promise<Locale> {
  const saved = (await cookies()).get(LOCALE_COOKIE)?.value;
  if (isLocale(saved)) return saved;
  return fromAcceptLanguage((await headers()).get('accept-language')) ?? DEFAULT_LOCALE;
}

export async function getI18n(): Promise<{ locale: Locale; t: Dictionary }> {
  const locale = await getLocale();
  return { locale, t: dictionaries[locale] };
}
