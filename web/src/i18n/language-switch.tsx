'use client';

import { useRouter } from 'next/navigation';
import { useI18n } from './client';
import { LOCALE_COOKIE, LOCALES, type Locale } from './config';

// Each language in its own name, so someone who cannot read the current one still
// finds theirs.
const LABELS: Record<Locale, { short: string; name: string }> = {
  kk: { short: 'ҚАЗ', name: 'Қазақша' },
  ru: { short: 'РУС', name: 'Русский' },
  en: { short: 'ENG', name: 'English' },
};

// A year, site-wide. The caller refreshes, so the server components render again with it.
function saveLocale(locale: Locale): void {
  document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=31536000; samesite=lax`;
}

export function LanguageSwitch() {
  const router = useRouter();
  const { locale, t } = useI18n();

  function choose(next: Locale) {
    if (next === locale) return;
    saveLocale(next);
    router.refresh();
  }

  return (
    <div role="group" aria-label={t.header.language} className="flex items-center gap-1 text-xs">
      {LOCALES.map((option) => (
        <button
          key={option}
          type="button"
          lang={option}
          title={LABELS[option].name}
          aria-pressed={option === locale}
          onClick={() => choose(option)}
          className={
            option === locale
              ? 'rounded px-1.5 py-1 font-semibold text-zinc-900'
              : 'rounded px-1.5 py-1 text-zinc-500 hover:text-zinc-900'
          }
        >
          {LABELS[option].short}
        </button>
      ))}
    </div>
  );
}
