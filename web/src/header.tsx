'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { ApiError, getMe } from '@/api';
import { useI18n } from '@/i18n/client';
import { LanguageSwitch } from '@/i18n/language-switch';
import { clearSession, readToken, saveSession, useSessionUser } from '@/session';

export function Header() {
  const pathname = usePathname();
  const router = useRouter();
  const user = useSessionUser();
  const { t } = useI18n();

  useEffect(() => {
    const token = readToken();
    if (!token) return;

    let cancelled = false;
    getMe(token)
      .then((next) => {
        // Logout or a newer login can win while this request is in flight.
        if (cancelled || readToken() !== token) return;
        saveSession(token, next);
      })
      .catch((error: unknown) => {
        if (cancelled || readToken() !== token) return;
        if (error instanceof ApiError && error.status === 401) clearSession();
      });

    return () => {
      cancelled = true;
    };
  }, [pathname]);

  function logout() {
    clearSession();
    router.push('/');
    router.refresh();
  }

  return (
    <header className="border-b border-zinc-200 bg-white">
      {/* On a phone the account links take a second row under the logo and the language
          switch. From sm up everything is one row, with the switch last. */}
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        <Link href="/" className="text-lg font-semibold tracking-tight">
          BiletFlow
        </Link>
        <div className="ml-auto sm:order-last sm:ml-0">
          <LanguageSwitch />
        </div>
        <nav
          aria-label={t.header.account}
          className="flex min-h-9 w-full flex-wrap items-center gap-x-4 gap-y-1 text-sm whitespace-nowrap sm:ml-auto sm:w-auto"
        >
          {user ? (
            <>
              {user.email_verified === false ? (
                <Link href="/inbox" className="text-zinc-600 hover:text-zinc-900">
                  {t.header.verifyEmail}
                </Link>
              ) : null}
              <Link href="/tickets" className="text-zinc-600 hover:text-zinc-900">
                {t.header.myTickets}
              </Link>
              <Link href="/orders" className="text-zinc-600 hover:text-zinc-900">
                {t.header.myOrders}
              </Link>
              <span className="font-medium">{user.name}</span>
              <button type="button" onClick={logout} className="text-zinc-600 hover:text-zinc-900">
                {t.header.logOut}
              </button>
            </>
          ) : (
            <>
              <Link href="/login" className="text-zinc-600 hover:text-zinc-900">
                {t.header.logIn}
              </Link>
              <Link href="/register" className="font-medium hover:text-zinc-700">
                {t.header.register}
              </Link>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}
