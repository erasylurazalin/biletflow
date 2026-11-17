'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import {
  ApiError,
  createOrganizerProfile,
  formatWhen,
  getOrganizerProfile,
  patchOrganizerProfile,
  verifyOrganizerIdentity,
  type OrganizerProfile,
  type OrganizerProfileInput,
} from '@/api';
import { useI18n } from '@/i18n/client';
import { errorText } from '@/i18n/errors';
import { clearSession, readToken, saveSession } from '@/session';

const loginPath = '/login?next=/organizer/profile';
const fieldClass =
  'mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-500';
const buttonClass =
  'rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-60';

export default function OrganizerProfilePage() {
  const router = useRouter();
  const { t } = useI18n();
  const [profile, setProfile] = useState<OrganizerProfile | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<unknown>(null);

  useEffect(() => {
    const token = readToken();
    if (!token) {
      router.replace(loginPath);
      return;
    }
    let active = true;
    getOrganizerProfile(token)
      .then((next) => {
        if (active && readToken() === token) setProfile(next.organizer_profile);
      })
      .catch((err: unknown) => {
        if (!active || readToken() !== token) return;
        if (err instanceof ApiError && err.status === 401) {
          clearSession();
          router.replace(loginPath);
        } else if (err instanceof ApiError && err.code === 'ORGANIZER_PROFILE_NOT_FOUND') {
          setProfile(null);
        } else {
          setLoadError(err);
        }
      });
    return () => {
      active = false;
    };
  }, [router]);

  if (loadError)
    return (
      <p role="alert" className="text-sm text-red-700">
        {errorText(loadError, t)}
      </p>
    );
  if (profile === undefined)
    return (
      <p role="status" className="text-sm text-zinc-600">
        {t.common.loading}
      </p>
    );
  return <ProfileForm initialProfile={profile} />;
}

function ProfileForm({ initialProfile }: { initialProfile: OrganizerProfile | null }) {
  const router = useRouter();
  const { locale, t } = useI18n();
  const [profile, setProfile] = useState(initialProfile);
  const [hasPayout, setHasPayout] = useState(initialProfile?.payout != null);
  const [contactMissing, setContactMissing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);

  async function mutate(operation: (token: string) => Promise<void>) {
    if (pending) return;
    const token = readToken();
    if (!token) {
      router.replace(loginPath);
      return;
    }
    setError(null);
    setSaved(false);
    setPending(true);
    try {
      await operation(token);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        clearSession();
        router.replace(loginPath);
      }
      setError(err);
    } finally {
      setPending(false);
    }
  }

  function onSubmit(submission: FormEvent<HTMLFormElement>) {
    submission.preventDefault();
    const data = new FormData(submission.currentTarget);
    const field = (name: string) => String(data.get(name) ?? '').trim();
    const input: OrganizerProfileInput = {
      display_name: field('display_name'),
      contact_email: field('contact_email') || null,
      contact_phone: field('contact_phone') || null,
      payout: hasPayout
        ? {
            bank_name: field('bank_name'),
            iban: field('iban'),
            account_holder: field('account_holder'),
          }
        : null,
    };
    if (!input.contact_email && !input.contact_phone) {
      setSaved(false);
      setError(null);
      setContactMissing(true);
      return;
    }
    setContactMissing(false);

    void mutate(async (token) => {
      if (!profile) {
        const next = await createOrganizerProfile(token, input);
        saveSession(next.token, { ...next.user, email_verified: true });
        router.replace('/organizer/events');
      } else {
        const next = await patchOrganizerProfile(token, input);
        setProfile(next.organizer_profile);
        setSaved(true);
      }
    });
  }

  function verifyIdentity() {
    void mutate(async (token) => {
      const next = await verifyOrganizerIdentity(token);
      setProfile(next.organizer_profile);
    });
  }

  return (
    <div className="mx-auto max-w-lg">
      <h1 className="text-2xl font-semibold">
        {profile ? t.organizerProfile.editTitle : t.organizerProfile.becomeTitle}
      </h1>
      <form onSubmit={onSubmit} className="mt-6 rounded-lg border border-zinc-200 bg-white p-5">
        <fieldset disabled={pending} className="space-y-3">
          <label className="block text-sm font-medium">
            {t.organizerProfile.displayName}
            <input
              name="display_name"
              defaultValue={profile?.display_name}
              required
              maxLength={100}
              className={fieldClass}
            />
          </label>
          <label className="block text-sm font-medium">
            {t.organizerProfile.contactEmail}
            <input
              name="contact_email"
              type="email"
              defaultValue={profile?.contact_email ?? ''}
              className={fieldClass}
            />
          </label>
          <label className="block text-sm font-medium">
            {t.organizerProfile.contactPhone}
            <input
              name="contact_phone"
              type="tel"
              defaultValue={profile?.contact_phone ?? ''}
              className={fieldClass}
            />
          </label>
          <fieldset className="space-y-3 border-t border-zinc-200 pt-3">
            <legend className="text-sm font-medium">{t.organizerProfile.payoutTitle}</legend>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={hasPayout}
                onChange={(e) => setHasPayout(e.target.checked)}
              />
              {t.organizerProfile.addPayout}
            </label>
            <fieldset disabled={!hasPayout} hidden={!hasPayout} className="space-y-3">
              <label className="block text-sm font-medium">
                {t.organizerProfile.bankName}
                <input
                  name="bank_name"
                  defaultValue={profile?.payout?.bank_name}
                  required
                  maxLength={100}
                  className={fieldClass}
                />
              </label>
              <label className="block text-sm font-medium">
                {t.organizerProfile.iban}
                <input
                  name="iban"
                  defaultValue={profile?.payout?.iban}
                  required
                  className={fieldClass}
                />
              </label>
              <label className="block text-sm font-medium">
                {t.organizerProfile.accountHolder}
                <input
                  name="account_holder"
                  defaultValue={profile?.payout?.account_holder}
                  required
                  maxLength={100}
                  className={fieldClass}
                />
              </label>
            </fieldset>
          </fieldset>
          <button type="submit" className={buttonClass}>
            {pending
              ? t.common.pleaseWait
              : profile
                ? t.organizerProfile.saveBtn
                : t.organizerProfile.becomeBtn}
          </button>
          {saved ? (
            <p role="status" className="text-sm text-zinc-600">
              {t.organizerProfile.saved}
            </p>
          ) : null}
        </fieldset>
      </form>
      {contactMissing ? (
        <p role="alert" className="mt-3 text-sm text-red-700">
          {t.organizerProfile.contactRequired}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-3 text-sm text-red-700">
          {errorText(error, t)}
        </p>
      ) : null}
      {profile?.identity_verified_at ? (
        <p className="mt-4 text-sm text-zinc-600">
          {t.organizerProfile.identityVerified} · {formatWhen(profile.identity_verified_at, locale)}
        </p>
      ) : profile ? (
        <button
          type="button"
          disabled={pending}
          onClick={verifyIdentity}
          className={`mt-4 ${buttonClass}`}
        >
          {t.organizerProfile.identityBtn}
        </button>
      ) : null}
    </div>
  );
}
