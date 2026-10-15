'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ApiError, loginAccount, registerAccount } from '@/api';
import { saveSession } from '@/session';

const fieldClass =
  'mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-500';

export function AuthForm({ mode }: { mode: 'login' | 'register' }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const isRegister = mode === 'register';

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
      router.push('/');
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="mx-auto w-full max-w-sm rounded-lg border border-zinc-200 bg-white p-6"
    >
      <h1 className="text-xl font-semibold">{isRegister ? 'Create an account' : 'Log in'}</h1>
      {isRegister ? (
        <label className="mt-4 block text-sm font-medium">
          Name
          <input name="name" required autoComplete="name" className={fieldClass} />
        </label>
      ) : null}
      <label className="mt-4 block text-sm font-medium">
        Email
        <input
          name="email"
          type="email"
          required
          autoComplete="email"
          className={fieldClass}
        />
      </label>
      <label className="mt-4 block text-sm font-medium">
        Password
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
        {pending ? 'Please wait…' : isRegister ? 'Create account' : 'Log in'}
      </button>
      <p className="mt-4 text-sm text-zinc-600">
        {isRegister ? (
          <Link href="/login" className="hover:text-zinc-900">
            Already have an account? Log in
          </Link>
        ) : (
          <Link href="/register" className="hover:text-zinc-900">
            Create an account
          </Link>
        )}
      </p>
    </form>
  );
}
