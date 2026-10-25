'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { verifyEmail } from '@/api';
import { useI18n } from '@/i18n/client';
import { errorText } from '@/i18n/errors';
import { readToken, saveSession } from '@/session';

function VerifyEmail() {
  const searchParams = useSearchParams();
  const { t } = useI18n();
  const token = searchParams.get('token');
  const [verified, setVerified] = useState(false);
  // The error itself, not its text: the token works once, so a language switch must
  // translate what is shown instead of running the request again.
  const [error, setError] = useState<unknown>(null);

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
        setError(err ?? new Error());
      });

    return () => {
      cancelled = true;
    };
  }, [token]);

  if (!token) return <p className="text-sm text-zinc-700">{t.common.missingToken}</p>;

  return (
    <div className="mx-auto w-full max-w-sm rounded-lg border border-zinc-200 bg-white p-6">
      {verified ? (
        <>
          <h1 className="text-xl font-semibold">{t.verifyEmail.verified}</h1>
          <Link href="/" className="mt-4 inline-block text-sm text-zinc-600 hover:text-zinc-900">
            {t.verifyEmail.home}
          </Link>
        </>
      ) : error !== null ? (
        <>
          <p role="alert" className="text-sm text-red-700">
            {errorText(error, t)}
          </p>
          <Link
            href="/inbox"
            className="mt-4 inline-block text-sm text-zinc-600 hover:text-zinc-900"
          >
            {t.common.openInbox}
          </Link>
        </>
      ) : (
        <p className="text-sm text-zinc-600">{t.verifyEmail.verifying}</p>
      )}
    </div>
  );
}

export default function VerifyEmailPage() {
  const { t } = useI18n();
  return (
    <Suspense fallback={<p className="text-sm text-zinc-600">{t.verifyEmail.verifying}</p>}>
      <VerifyEmail />
    </Suspense>
  );
}
