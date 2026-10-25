'use client';

// The locale for client components. The root layout works it out on the server and
// passes it down, so the first render already matches the server HTML.
import { createContext, useContext, type ReactNode } from 'react';
import { DEFAULT_LOCALE, type Locale } from './config';
import { dictionaries, type Dictionary } from './index';

const LocaleContext = createContext<Locale>(DEFAULT_LOCALE);

export function LocaleProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

export function useI18n(): { locale: Locale; t: Dictionary } {
  const locale = useContext(LocaleContext);
  return { locale, t: dictionaries[locale] };
}
