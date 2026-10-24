'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { ApiError, verifyEmail } from '@/api';
import { readToken, saveSession } from '@/session';

function VerifyEmail() {
  const searchParams = useSearchParams();
  const token = searchParams.get('token');
  const [verified, setVerified] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;

    let cancelled = false;
    verifyEmail(token)
      .then((user) => {
        if (cancelled) return;
        const authToken = readToken();
        if (authToken) saveSession(authToken, user);
        setVerified(true);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
      });

    return () => {
      cancelled = true;
    };
  }, [token]);

  if (!token) return <p className="text-sm text-zinc-700">This link is missing its token.</p>;

  return (
    <div className="mx-auto w-full max-w-sm rounded-lg border border-zinc-200 bg-white p-6">
      {verified ? (
        <>
          <h1 className="text-xl font-semibold">Your email is verified.</h1>
          <Link href="/" className="mt-4 inline-block text-sm text-zinc-600 hover:text-zinc-900">
            Go to the home page
          </Link>
        </>
      ) : error ? (
        <>
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
          <Link
            href="/inbox"
            className="mt-4 inline-block text-sm text-zinc-600 hover:text-zinc-900"
          >
            Open the simulated inbox
          </Link>
        </>
      ) : (
        <p className="text-sm text-zinc-600">Verifying your email…</p>
      )}
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={<p className="text-sm text-zinc-600">Verifying your email…</p>}>
      <VerifyEmail />
    </Suspense>
  );
}
