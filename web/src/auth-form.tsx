'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { loginAccount, registerAccount } from '@/api';
import { useI18n } from '@/i18n/client';
import { errorText } from '@/i18n/errors';
import { saveSession } from '@/session';

const fieldClass =
  'mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-500';

export function AuthForm({ mode }: { mode: 'login' | 'register' }) {
  const router = useRouter();
  const { t } = useI18n();
  const searchParams = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const isRegister = mode === 'register';
  const requestedNext = searchParams.get('next');
  // Only same-site paths: "//host" and "/\host" would send the user to another site.
  const next = /^\/(?![/\\])/.test(requestedNext ?? '') ? requestedNext! : '/';
  const loginHref = next === '/' ? '/login' : `/login?next=${encodeURIComponent(next)}`;
  const registerHref = next === '/' ? '/register' : `/register?next=${encodeURIComponent(next)}`;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setError(null);
    setPending(true);

    const data = new FormData(event.currentTarget);
    const email = String(data.get('email') ?? '');
    const password = String(data.get('password') ?? '');

    try {
      const session = isRegister
        ? await registerAccount({
            name: String(data.get('name') ?? ''),
            email,
            password,
          })
        : await loginAccount({ email, password });
      saveSession(session.token, session.user);
      router.push(next);
      router.refresh();
    } catch (err) {
      setError(errorText(err, t));
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="mx-auto w-full max-w-sm rounded-lg border border-zinc-200 bg-white p-6"
    >
      <h1 className="text-xl font-semibold">{isRegister ? t.auth.registerTitle : t.auth.logInTitle}</h1>
      {isRegister ? (
        <label className="mt-4 block text-sm font-medium">
          {t.auth.name}
          <input name="name" required autoComplete="name" className={fieldClass} />
        </label>
      ) : null}
      <label className="mt-4 block text-sm font-medium">
        {t.common.email}
        <input
          name="email"
          type="email"
          required
          autoComplete="email"
          className={fieldClass}
        />
      </label>
      <label className="mt-4 block text-sm font-medium">
        {t.auth.password}
        <input
          name="password"
          type="password"
          required
          autoComplete={isRegister ? 'new-password' : 'current-password'}
          className={fieldClass}
        />
      </label>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-red-700">
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="mt-5 w-full rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-60"
      >
        {pending ? t.common.pleaseWait : isRegister ? t.auth.createAccount : t.auth.logIn}
      </button>
      <p className="mt-4 text-sm text-zinc-600">
        {isRegister ? (
          <Link href={loginHref} className="hover:text-zinc-900">
            {t.auth.haveAccount}
          </Link>
        ) : (
          <span className="flex gap-4">
            <Link href={registerHref} className="hover:text-zinc-900">
              {t.auth.noAccount}
            </Link>
            <Link href="/forgot-password" className="hover:text-zinc-900">
              {t.auth.forgotPassword}
            </Link>
          </span>
        )}
      </p>
    </form>
  );
}
