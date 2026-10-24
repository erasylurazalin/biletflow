'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { ApiError, confirmPasswordReset } from '@/api';
import { saveSession } from '@/session';

const fieldClass =
  'mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-500';

function ResetPassword() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get('token');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !token) return;

    const password = String(new FormData(event.currentTarget).get('password') ?? '');
    setError(null);
    setPending(true);
    try {
      const session = await confirmPasswordReset(token, password);
      saveSession(session.token, session.user);
      router.push('/');
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
    } finally {
      setPending(false);
    }
  }

  if (!token) return <p className="text-sm text-zinc-700">This link is missing its token.</p>;

  return (
    <form
      onSubmit={onSubmit}
      className="mx-auto w-full max-w-sm rounded-lg border border-zinc-200 bg-white p-6"
    >
      <h1 className="text-xl font-semibold">Set a new password</h1>
      <label className="mt-4 block text-sm font-medium">
        New password
        <input
          name="password"
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
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
        {pending ? 'Please wait…' : 'Set new password'}
      </button>
    </form>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<p className="text-sm text-zinc-600">Loading…</p>}>
      <ResetPassword />
    </Suspense>
  );
}
