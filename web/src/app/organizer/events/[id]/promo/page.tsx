'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  createPromoCampaign,
  formatPrice,
  formatWhen,
  listPromoCampaigns,
  setPromoCampaignActive,
  type PromoCampaign,
  type PromoCampaignInput,
} from '@/api';
import { clearSession, readToken } from '@/session';

// formatPrice says "Free" for 0, which reads wrong for revenue.
function formatMoney(tiyn: number): string {
  return tiyn === 0 ? '0 ₸' : formatPrice(tiyn);
}

const buttonClass =
  'rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-60';
const inputClass =
  'w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm';

// The campaign QR code, fetched with the Bearer token and shown from an object URL.
function CampaignQr({ campaignId, code }: { campaignId: string; code: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    (async () => {
      const token = readToken();
      if (!token) return;
      try {
        const response = await fetch(`/api/promo-campaigns/${campaignId}/qr.png`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!response.ok) throw new Error(String(response.status));
        const blob = await response.blob();
        objectUrl = URL.createObjectURL(blob);
        if (!cancelled) setUrl(objectUrl);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [campaignId]);

  if (failed) {
    return <p className="text-sm text-zinc-500">Could not load the QR code.</p>;
  }
  if (!url) {
    return <div className="h-32 w-32 rounded bg-zinc-200" />;
  }
  return (
    <div className="flex items-center gap-3">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt={`Campaign QR code for ${code}`}
        width={128}
        height={128}
        className="rounded bg-white"
      />
      <a href={url} download={`promo-${code}.png`} className="text-sm font-medium underline">
        Download
      </a>
    </div>
  );
}

function PromoCampaigns() {
  const { id: eventId } = useParams<{ id: string }>();
  const router = useRouter();
  const [campaigns, setCampaigns] = useState<PromoCampaign[] | null>(null);
  const [ticketTypes, setTicketTypes] = useState<
    { id: string; name: string; price: number; is_hidden: boolean }[]
  >([]);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const loginPath = `/login?next=${encodeURIComponent(`/organizer/events/${eventId}/promo`)}`;

  // The create form.
  const [name, setName] = useState('');
  const [discountType, setDiscountType] = useState<'percent' | 'fixed'>('percent');
  const [value, setValue] = useState('');
  const [code, setCode] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [maxUses, setMaxUses] = useState('');
  const [scope, setScope] = useState<'all' | 'some'>('all');
  const [checkedTypes, setCheckedTypes] = useState<string[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const loading = campaigns === null && error === null;

  const showError = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) {
        clearSession();
        router.replace(loginPath);
        return;
      }
      if (err instanceof ApiError && err.status === 403) {
        setError("Only the event's organizer can manage its campaigns");
        return;
      }
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
    },
    [loginPath, router],
  );

  const refresh = useCallback(async () => {
    const token = readToken();
    if (!token) {
      router.replace(loginPath);
      return;
    }
    setPending('refresh');
    try {
      const body = await listPromoCampaigns(eventId, token);
      setCampaigns(body.campaigns);
      setTicketTypes(body.ticket_types);
      setError(null);
    } catch (err) {
      showError(err);
    } finally {
      setPending(null);
    }
  }, [eventId, loginPath, router, showError]);

  useEffect(() => {
    const token = readToken();
    if (!token) {
      router.replace(loginPath);
      return;
    }
    let cancelled = false;
    listPromoCampaigns(eventId, token)
      .then((body) => {
        if (cancelled) return;
        setCampaigns(body.campaigns);
        setTicketTypes(body.ticket_types);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) showError(err);
      });
    return () => {
      cancelled = true;
    };
  }, [eventId, loginPath, router, showError]);

  async function create() {
    const token = readToken();
    if (!token) {
      router.replace(loginPath);
      return;
    }
    const parsedValue = Number(value);
    if (!name.trim() || !Number.isInteger(parsedValue) || parsedValue <= 0) {
      setFormError('Give the campaign a name and a discount above 0.');
      return;
    }
    const input: PromoCampaignInput = {
      name: name.trim(),
      discount_type: discountType,
      discount_value: discountType === 'fixed' ? Math.round(parsedValue * 100) : parsedValue,
      ...(scope === 'some' && checkedTypes.length > 0 && { ticket_type_ids: checkedTypes }),
    };
    if (code.trim()) input.code = code.trim();
    if (startsAt) input.starts_at = new Date(startsAt).toISOString();
    if (endsAt) input.ends_at = new Date(endsAt).toISOString();
    if (maxUses) input.max_redemptions = Number(maxUses);

    setFormError(null);
    setPending('create');
    try {
      await createPromoCampaign(eventId, input, token);
      setName('');
      setValue('');
      setCode('');
      setStartsAt('');
      setEndsAt('');
      setMaxUses('');
      setScope('all');
      setCheckedTypes([]);
      await refresh();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        clearSession();
        router.replace(loginPath);
        return;
      }
      setFormError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
    } finally {
      setPending(null);
    }
  }

  async function setActive(campaign: PromoCampaign, isActive: boolean) {
    const token = readToken();
    if (!token) {
      router.replace(loginPath);
      return;
    }
    setError(null);
    setPending(`toggle:${campaign.id}`);
    try {
      await setPromoCampaignActive(campaign.id, isActive, token);
      await refresh();
    } catch (err) {
      showError(err);
    } finally {
      setPending(null);
    }
  }

  function copyLink(campaign: PromoCampaign) {
    navigator.clipboard
      .writeText(campaign.link)
      .then(() => {
        setCopied(campaign.id);
        window.setTimeout(() => setCopied(null), 2000);
      })
      .catch(() => {
        setCopied(null);
      });
  }

  function discountText(campaign: PromoCampaign): string {
    return campaign.discount_type === 'percent'
      ? `${campaign.discount_value}%`
      : formatPrice(campaign.discount_value);
  }

  return (
    <div className="mx-auto max-w-2xl">
      <Link href={`/events/${eventId}`} className="text-sm text-zinc-500 hover:text-zinc-800">
        ← Event
      </Link>
      <h1 className="mt-4 text-2xl font-semibold">Promo campaigns</h1>
      <p className="mt-2 text-sm text-zinc-600">
        Each campaign gets a promo code and a campaign QR code: a picture of the event
        link with a secret token, never a price.
      </p>

      {error ? (
        <p role="alert" className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      {loading ? <p className="mt-6 text-sm text-zinc-600">Loading campaigns…</p> : null}

      {campaigns ? (
        <>
          <section className="mt-6 rounded-lg border border-zinc-200 bg-white p-5">
            <h2 className="text-lg font-medium">New campaign</h2>
            <form
              className="mt-4 space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                void create();
              }}
            >
              <label className="block text-sm">
                <span className="mb-1 block font-medium">Name</span>
                <input
                  type="text"
                  maxLength={100}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  className={inputClass}
                />
              </label>
              <div className="flex gap-3">
                <label className="block text-sm">
                  <span className="mb-1 block font-medium">Discount</span>
                  <select
                    value={discountType}
                    onChange={(event) =>
                      setDiscountType(event.target.value as 'percent' | 'fixed')
                    }
                    className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm"
                  >
                    <option value="percent">Percent</option>
                    <option value="fixed">Fixed (KZT)</option>
                  </select>
                </label>
                <label className="block flex-1 text-sm">
                  <span className="mb-1 block font-medium">
                    {discountType === 'percent' ? 'Percent (1-100)' : 'Amount in KZT'}
                  </span>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={value}
                    onChange={(event) => setValue(event.target.value)}
                    className={inputClass}
                  />
                </label>
              </div>
              <div className="flex gap-3">
                <label className="block flex-1 text-sm">
                  <span className="mb-1 block font-medium">Code (optional)</span>
                  <input
                    type="text"
                    maxLength={20}
                    placeholder="Generated if empty"
                    value={code}
                    onChange={(event) => setCode(event.target.value.toUpperCase())}
                    className={inputClass}
                  />
                </label>
                <label className="block flex-1 text-sm">
                  <span className="mb-1 block font-medium">Max uses (optional)</span>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={maxUses}
                    onChange={(event) => setMaxUses(event.target.value)}
                    className={inputClass}
                  />
                </label>
              </div>
              <div className="flex gap-3">
                <label className="block flex-1 text-sm">
                  <span className="mb-1 block font-medium">Starts (optional)</span>
                  <input
                    type="datetime-local"
                    value={startsAt}
                    onChange={(event) => setStartsAt(event.target.value)}
                    className={inputClass}
                  />
                </label>
                <label className="block flex-1 text-sm">
                  <span className="mb-1 block font-medium">Ends (optional)</span>
                  <input
                    type="datetime-local"
                    value={endsAt}
                    onChange={(event) => setEndsAt(event.target.value)}
                    className={inputClass}
                  />
                </label>
              </div>
              <fieldset className="text-sm">
                <legend className="mb-1 font-medium">Which ticket types</legend>
                <div className="flex gap-4">
                  <label className="flex items-center gap-1">
                    <input
                      type="radio"
                      name="scope"
                      checked={scope === 'all'}
                      onChange={() => setScope('all')}
                    />
                    All
                  </label>
                  <label className="flex items-center gap-1">
                    <input
                      type="radio"
                      name="scope"
                      checked={scope === 'some'}
                      onChange={() => setScope('some')}
                    />
                    Selected
                  </label>
                </div>
                {scope === 'some' ? (
                  <ul className="mt-2 space-y-1">
                    {ticketTypes.map((type) => (
                      <li key={type.id} className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={checkedTypes.includes(type.id)}
                          onChange={(event) =>
                            setCheckedTypes((current) =>
                              event.target.checked
                                ? [...current, type.id]
                                : current.filter((id) => id !== type.id),
                            )
                          }
                          id={`type-${type.id}`}
                        />
                        <label htmlFor={`type-${type.id}`}>
                          {type.name} ({formatPrice(type.price)})
                          {type.is_hidden ? ' · hidden' : ''}
                        </label>
                      </li>
                    ))}
                    {ticketTypes.length === 0 ? (
                      <li className="text-zinc-500">This event has no ticket types yet.</li>
                    ) : null}
                  </ul>
                ) : null}
              </fieldset>
              {formError ? (
                <p role="alert" className="text-sm text-red-700">
                  {formError}
                </p>
              ) : null}
              <button
                type="submit"
                disabled={pending !== null}
                className={buttonClass}
              >
                {pending === 'create' ? 'Creating…' : 'Create campaign'}
              </button>
            </form>
          </section>

          <ul className="mt-6 divide-y divide-zinc-200 rounded-lg border border-zinc-200 bg-white px-5">
            {campaigns.length === 0 ? (
              <li className="py-4 text-sm text-zinc-600">No campaigns yet.</li>
            ) : null}
            {campaigns.map((campaign) => (
              <li key={campaign.id} className="py-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium text-zinc-900">
                      {campaign.name} · <span className="font-mono">{campaign.code}</span>
                    </p>
                    <p className="mt-1 text-sm text-zinc-600">
                      {discountText(campaign)} off
                      {campaign.max_redemptions !== null
                        ? ` · uses: ${campaign.redemptions} of ${campaign.max_redemptions}`
                        : ` · uses: ${campaign.redemptions}`}
                    </p>
                    <p className="mt-1 text-sm text-zinc-600">
                      {campaign.orders} orders · {campaign.tickets_sold} tickets · gross{' '}
                      {formatMoney(campaign.gross_revenue)} · discounts{' '}
                      {formatMoney(campaign.discount_total)} · net{' '}
                      {formatMoney(campaign.net_revenue)}
                    </p>
                    {campaign.starts_at || campaign.ends_at ? (
                      <p className="mt-1 text-sm text-zinc-500">
                        {campaign.starts_at ? `from ${formatWhen(campaign.starts_at)}` : ''}
                        {campaign.starts_at && campaign.ends_at ? ' ' : ''}
                        {campaign.ends_at ? `until ${formatWhen(campaign.ends_at)}` : ''}
                      </p>
                    ) : null}
                  </div>
                  <div className="text-right">
                    <p className="text-sm text-zinc-600">
                      {campaign.is_active ? 'Active' : 'Disabled'}
                    </p>
                    <button
                      type="button"
                      disabled={pending !== null}
                      onClick={() =>
                        void setActive(campaign, !campaign.is_active)
                      }
                      className={`${buttonClass} mt-2`}
                    >
                      {pending === `toggle:${campaign.id}`
                        ? 'Saving…'
                        : campaign.is_active
                          ? 'Disable'
                          : 'Enable'}
                    </button>
                  </div>
                </div>

                <div className="mt-3 flex items-center gap-2">
                  <code className="max-w-full truncate rounded bg-zinc-100 px-2 py-1 text-xs">
                    {campaign.link}
                  </code>
                  <button
                    type="button"
                    onClick={() => copyLink(campaign)}
                    className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs font-medium text-zinc-600"
                  >
                    {copied === campaign.id ? 'Copied' : 'Copy'}
                  </button>
                </div>

                <div className="mt-3">
                  <CampaignQr campaignId={campaign.id} code={campaign.code} />
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

export default function EventPromoPage() {
  return (
    <Suspense fallback={<p className="text-sm text-zinc-600">Loading campaigns…</p>}>
      <PromoCampaigns />
    </Suspense>
  );
}
