import type { Metadata } from 'next';
import { Geist } from 'next/font/google';
import { Header } from '@/header';
import { LocaleProvider } from '@/i18n/client';
import { getI18n, getLocale } from '@/i18n/server';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  // Russian needs cyrillic, and the Kazakh letters (ә, ғ, қ, ң, ө, ұ, ү, і) are in
  // cyrillic-ext. Without them that text falls back to another font.
  subsets: ['latin', 'cyrillic', 'cyrillic-ext'],
});

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getI18n();
  return {
    title: 'BiletFlow',
    description: t.meta.description,
  };
}

export default async function RootLayout({ children }: LayoutProps<'/'>) {
  const locale = await getLocale();
  return (
    <html lang={locale} className={`${geistSans.variable} h-full antialiased`}>
      <body className="min-h-full bg-zinc-50 text-zinc-900">
        <LocaleProvider locale={locale}>
          <Header />
          <main className="mx-auto w-full max-w-5xl px-4 py-8">{children}</main>
        </LocaleProvider>
      </body>
    </html>
  );
}
