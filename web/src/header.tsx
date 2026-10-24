'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { ApiError, getMe } from '@/api';
import { clearSession, readToken, saveSession, useSessionUser } from '@/session';

export function Header() {
  const pathname = usePathname();
  const router = useRouter();
  const user = useSessionUser();

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
      <div className="mx-auto flex max-w-5xl items-center px-4 py-3">
        <Link href="/" className="text-lg font-semibold tracking-tight">
          BiletFlow
        </Link>
        <nav aria-label="Account" className="ml-auto flex h-9 items-center gap-4 text-sm">
          {user ? (
            <>
              {user.email_verified === false ? (
                <Link href="/inbox" className="text-zinc-600 hover:text-zinc-900">
                  Verify your email
                </Link>
              ) : null}
              <Link href="/tickets" className="text-zinc-600 hover:text-zinc-900">
                My tickets
              </Link>
              <Link href="/orders" className="text-zinc-600 hover:text-zinc-900">
                My orders
              </Link>
              <span className="font-medium">{user.name}</span>
              <button type="button" onClick={logout} className="text-zinc-600 hover:text-zinc-900">
                Log out
              </button>
            </>
          ) : (
            <>
              <Link href="/login" className="text-zinc-600 hover:text-zinc-900">
                Log in
              </Link>
              <Link href="/register" className="font-medium hover:text-zinc-700">
                Register
              </Link>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}
