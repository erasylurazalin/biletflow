import { useState, type FormEvent } from 'react';
import type { CreateEventInput } from '@/api';
import { useI18n } from '@/i18n/client';

export const buttonClass =
  'rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-60';
export const fieldClass =
  'mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-500';

function localDateTime(value: string): string {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function EventForm({
  event,
  pending,
  onSave,
}: {
  event?: CreateEventInput;
  pending: boolean;
  onSave: (input: CreateEventInput) => void;
}) {
  const { t } = useI18n();
  const [invalidDates, setInvalidDates] = useState(false);

  function onSubmit(submission: FormEvent<HTMLFormElement>) {
    submission.preventDefault();
    const data = new FormData(submission.currentTarget);
    const field = (name: string) => String(data.get(name) ?? '').trim();
    const timestamp = (name: 'starts_at' | 'ends_at') => {
      const value = field(name);
      const original = event?.[name];
      return original && value === localDateTime(original)
        ? original
        : new Date(value).toISOString();
    };
    const starts_at = timestamp('starts_at');
    const ends_at = timestamp('ends_at');
    if (Date.parse(ends_at) <= Date.parse(starts_at)) {
      setInvalidDates(true);
      return;
    }
    setInvalidDates(false);
    onSave({
      title: field('title'),
      description: field('description'),
      venue_name: field('venue_name'),
      venue_address: field('venue_address'),
      starts_at,
      ends_at,
      cover_image_url: field('cover_image_url') || null,
      refund_policy: field('refund_policy') || null,
    });
  }

  return (
    <form onSubmit={onSubmit} className="mt-4 rounded-lg border border-zinc-200 bg-white p-5">
      <fieldset disabled={pending} className="space-y-3">
        <label className="block text-sm font-medium">
          {t.events.title}
          <input
            name="title"
            defaultValue={event?.title}
            maxLength={200}
            required
            className={fieldClass}
          />
        </label>
        <label className="block text-sm font-medium">
          {t.events.description}
          <textarea
            name="description"
            defaultValue={event?.description}
            required
            className={fieldClass}
          />
        </label>
        <label className="block text-sm font-medium">
          {t.events.venueName}
          <input
            name="venue_name"
            defaultValue={event?.venue_name}
            maxLength={200}
            required
            className={fieldClass}
          />
        </label>
        <label className="block text-sm font-medium">
          {t.events.venueAddress}
          <input
            name="venue_address"
            defaultValue={event?.venue_address}
            maxLength={300}
            required
            className={fieldClass}
          />
        </label>
        <label className="block text-sm font-medium">
          {t.events.startsAt}
          <input
            name="starts_at"
            type="datetime-local"
            defaultValue={event && localDateTime(event.starts_at)}
            required
            className={fieldClass}
          />
        </label>
        <label className="block text-sm font-medium">
          {t.events.endsAt}
          <input
            name="ends_at"
            type="datetime-local"
            defaultValue={event && localDateTime(event.ends_at)}
            required
            className={fieldClass}
          />
        </label>
        <p className="text-xs text-zinc-500">{t.events.localTimeNote}</p>
        <label className="block text-sm font-medium">
          {t.events.coverImage}
          <input
            name="cover_image_url"
            type="url"
            defaultValue={event?.cover_image_url ?? ''}
            className={fieldClass}
          />
        </label>
        <label className="block text-sm font-medium">
          {t.events.refundPolicy}
          <textarea
            name="refund_policy"
            defaultValue={event?.refund_policy ?? ''}
            maxLength={2000}
            className={fieldClass}
          />
        </label>
        {invalidDates ? (
          <p role="alert" className="text-sm text-red-700">
            {t.events.invalidDates}
          </p>
        ) : null}
        <button type="submit" className={buttonClass}>
          {pending ? t.common.pleaseWait : event ? t.events.save : t.events.createBtn}
        </button>
      </fieldset>
    </form>
  );
}
