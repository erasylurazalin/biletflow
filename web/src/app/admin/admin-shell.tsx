'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { useI18n } from '@/i18n/client';
import { readToken, useSessionUser } from '@/session';

const NAV = [
  { href: '/admin', key: 'navOverview' },
  { href: '/admin/reports', key: 'navReports' },
  { href: '/admin/settings', key: 'navSettings' },
] as const;

// The shared frame for the admin pages. The children are a function so a page's
// fetching components only mount when the caller really is a platform admin, not on
// the "not allowed" screen.
export function AdminShell({
  title,
  intro,
  children,
}: {
  title: string;
  intro?: string;
  children: (token: string) => ReactNode;
}) {
  const pathname = usePathname();
  const user = useSessionUser();
  const { t } = useI18n();
  const token = readToken();

  if (!user || user.role !== 'platform_admin' || !token) {
    return (
      <div className="mx-auto max-w-2xl rounded-lg border border-zinc-200 bg-white p-6">
        <h1 className="text-xl font-semibold">{t.admin.title}</h1>
        <p className="mt-3 text-sm text-zinc-600">{t.admin.notAllowed}</p>
        <Link href="/" className="mt-4 inline-block text-sm text-zinc-600 hover:text-zinc-900">
          {t.event.back}
        </Link>
      </div>
    );
  }

  return (
    <div>
      <nav aria-label={t.admin.title} className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
        {NAV.map((item) => {
          const active = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={
                active
                  ? 'font-medium text-zinc-950 underline underline-offset-4'
                  : 'text-zinc-600 hover:text-zinc-900'
              }
            >
              {t.admin[item.key]}
            </Link>
          );
        })}
      </nav>
      <h1 className="mt-6 text-2xl font-semibold">{title}</h1>
      {intro ? <p className="mt-2 max-w-3xl text-sm text-zinc-600">{intro}</p> : null}
      {children(token)}
    </div>
  );
}
