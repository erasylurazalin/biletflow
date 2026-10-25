import { INTL_LOCALE, type Locale } from './config';
import { dictionaries } from './index';

// One plural message: English needs one and other, Russian also few and many.
// Kazakh nouns do not change after a number, so kk only fills one and other.
export type Plural = { one: string; few?: string; many?: string; other: string };

// Fills {name} placeholders. A placeholder with no value is left as it is, so a typo
// in a dictionary shows up on the page instead of vanishing.
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? String(values[key]) : match,
  );
}

// Picks the plural form for count and fills {count} (and any other values) into it.
export function plural(
  locale: Locale,
  forms: Plural,
  count: number,
  values: Record<string, string | number> = {},
): string {
  const category = new Intl.PluralRules(INTL_LOCALE[locale]).select(count);
  const form =
    (category === 'one' && forms.one) ||
    (category === 'few' && forms.few) ||
    (category === 'many' && forms.many) ||
    forms.other;
  return fill(form, { count, ...values });
}

// Numbers and dates are formatted here rather than by toLocaleString, because the
// browser's locale data is not ours to choose: headless Chromium, for one, has no
// Kazakh and writes "5,000" and "2026 M11 24". The server has full data, so the
// browser's text would differ from the server HTML and break hydration.

// 5000 -> "5 000" (a no-break space) in kk and ru, "5,000" in en.
export function formatNumber(value: number, locale: Locale): string {
  const separator = locale === 'en' ? ',' : '\u00a0';
  const sign = value < 0 ? '-' : '';
  return sign + Math.abs(Math.trunc(value)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, separator);
}

// Always Kazakhstan time, whatever the reader's clock says: the events are there.
// en-US with numeric parts is the one format every Intl implementation has.
const ALMATY_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Almaty',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

// "2026 ж. 24 қар., 20:00", "24 нояб. 2026 г., 20:00", "24 Nov 2026, 20:00".
export function formatDateTime(iso: string, locale: Locale): string {
  const parts: Record<string, string> = {};
  for (const part of ALMATY_PARTS.formatToParts(new Date(iso))) parts[part.type] = part.value;
  const { dateTime, months } = dictionaries[locale].calendar;
  return fill(dateTime, {
    year: parts.year ?? '',
    month: months[Number(parts.month) - 1] ?? '',
    day: parts.day ?? '',
    time: `${parts.hour}:${parts.minute}`,
  });
}
