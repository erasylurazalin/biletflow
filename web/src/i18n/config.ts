// The languages the web app speaks (SRS 7): Kazakh and Russian, with English as an
// extra. Shared by server and client code, so nothing here may import next/headers.

export const LOCALES = ['kk', 'ru', 'en'] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'kk';

// The language switch writes this cookie and the root layout reads it, so the choice
// survives reloads and the server renders the right language from the first byte.
export const LOCALE_COOKIE = 'biletflow.lang';

export function isLocale(value: string | undefined | null): value is Locale {
  return (LOCALES as readonly string[]).includes(value ?? '');
}

// What Intl gets for dates, numbers and plural rules. Kazakhstan formats for kk and
// ru. en-GB rather than en-US, so English shows 24-hour times like the other two.
export const INTL_LOCALE: Record<Locale, string> = {
  kk: 'kk-KZ',
  ru: 'ru-KZ',
  en: 'en-GB',
};
