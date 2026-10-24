'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { ApiError, requestPasswordReset } from '@/api';

const fieldClass =
  'mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-500';

export default function ForgotPasswordPage() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submittedEmail, setSubmittedEmail] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    const email = String(new FormData(event.currentTarget).get('email') ?? '');
    setError(null);
    setSubmittedEmail(null);
    setPending(true);
    try {
      await requestPasswordReset(email);
      setSubmittedEmail(email);
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
      <h1 className="text-xl font-semibold">Reset your password</h1>
      <label className="mt-4 block text-sm font-medium">
        Email
        <input name="email" type="email" required autoComplete="email" className={fieldClass} />
      </label>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-red-700">
          {error}
        </p>
      ) : null}
      {submittedEmail !== null ? (
        <div className="mt-4 text-sm text-zinc-600">
          <p>If an account exists for that email, we sent a reset link.</p>
          <Link
            href={`/inbox?email=${encodeURIComponent(submittedEmail)}`}
            className="mt-2 inline-block hover:text-zinc-900"
          >
            Open the simulated inbox
          </Link>
        </div>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="mt-5 w-full rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-60"
      >
        {pending ? 'Please wait…' : 'Send reset link'}
      </button>
    </form>
  );
}
