'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import {
  ApiError,
  cancelEvent,
  createTicketType,
  deleteTicketType,
  duplicateEvent,
  formatWhen,
  getManagedEvent,
  publishEvent,
  updateEvent,
  updateTicketType,
  type CreateEventInput,
  type EventDetail,
  type TicketType,
} from '@/api';
import { useI18n } from '@/i18n/client';
import { INTL_LOCALE } from '@/i18n/config';
import { errorText } from '@/i18n/errors';
import { clearSession, readToken } from '@/session';
import { buttonClass, EventForm, fieldClass } from '../event-form';

const textButtonClass = 'text-sm text-zinc-600 hover:underline disabled:opacity-60';
const dangerClass =
  'rounded-md border border-red-200 px-3 py-2 text-sm font-medium text-red-700 disabled:opacity-60';

function TicketFields({ type }: { type?: TicketType }) {
  const { t } = useI18n();

  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <label className="block text-sm font-medium">
        {t.events.ticketTypeName}
        <input
          name="name"
          defaultValue={type?.name}
          required
          maxLength={100}
          className={fieldClass}
        />
      </label>
      <label className="block text-sm font-medium">
        {t.events.priceKzt}
        <input
          name="price"
          type="number"
          min="0"
          max="21474836.47"
          step="0.01"
          defaultValue={type ? type.price / 100 : 0}
          required
          className={fieldClass}
        />
      </label>
      <label className="block text-sm font-medium">
        {t.events.quantity}
        <input
          name="quantity"
          type="number"
          min="0"
          max="2147483647"
          defaultValue={type?.quantity_total}
          required
          className={fieldClass}
        />
      </label>
      <label className="flex items-center gap-2 text-sm sm:col-span-3">
        <input name="hidden" type="checkbox" defaultChecked={type?.is_hidden} />
        {t.events.hiddenTicketType}
      </label>
    </div>
  );
}

function EventManage({ initialEvent }: { initialEvent: EventDetail }) {
  const router = useRouter();
  const { locale, t } = useI18n();
  const [event, setEvent] = useState(initialEvent);
  const [editEvent, setEditEvent] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const cancelled = event.status === 'cancelled';
  const eventPath = `/organizer/events/${event.id}`;
  const ticketTypes = event.ticket_types;
  const priceFormatter = new Intl.NumberFormat(INTL_LOCALE[locale], {
    style: 'currency',
    currency: 'KZT',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });

  async function mutate(operation: (token: string) => Promise<void>) {
    if (pending) return;
    const token = readToken();
    if (!token) {
      router.replace(`/login?next=${eventPath}`);
      return;
    }
    setPending(true);
    setError(null);
    try {
      await operation(token);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        clearSession();
        router.replace(`/login?next=${eventPath}`);
      }
      setError(err);
    } finally {
      setPending(false);
    }
  }

  function saveEvent(input: CreateEventInput) {
    void mutate(async (token) => {
      const next = await updateEvent(token, event.id, input);
      setEvent((current) => ({ ...current, ...next.event }));
      setEditEvent(false);
    });
  }

  function saveTicket(submission: FormEvent<HTMLFormElement>, id?: string) {
    submission.preventDefault();
    const form = submission.currentTarget;
    const data = new FormData(form);
    const input = {
      name: String(data.get('name') ?? '').trim(),
      price: Math.round(Number(data.get('price')) * 100),
      quantity_total: Number(data.get('quantity')),
      is_hidden: data.has('hidden'),
    };
    void mutate(async (token) => {
      const { ticket_type } = id
        ? await updateTicketType(token, id, input)
        : await createTicketType(event.id, token, input);
      setEvent((current) => ({
        ...current,
        ticket_types: id
          ? current.ticket_types.map((type) => (type.id === id ? ticket_type : type))
          : [...current.ticket_types, ticket_type],
      }));
      if (id) setEditing(null);
      else form.reset();
    });
  }

  function removeTicket(id: string) {
    if (!window.confirm(t.events.removeConfirm)) return;
    void mutate(async (token) => {
      await deleteTicketType(token, id);
      setEvent((current) => ({
        ...current,
        ticket_types: current.ticket_types.filter((type) => type.id !== id),
      }));
    });
  }

  function changeStatus(action: 'publish' | 'cancel') {
    if (action === 'cancel' && !window.confirm(t.events.cancelConfirm)) return;
    void mutate(async (token) => {
      const next =
        action === 'publish'
          ? await publishEvent(token, event.id)
          : await cancelEvent(token, event.id);
      setEvent((current) => ({ ...current, ...next.event }));
      if (action === 'cancel') {
        setEditEvent(false);
        setEditing(null);
      }
    });
  }

  function duplicate() {
    if (!window.confirm(t.history.duplicateConfirm)) return;
    setDuplicating(true);
    void mutate(async (token) => {
      const { event: copy } = await duplicateEvent(token, event.id);
      router.push(`/organizer/events/${copy.id}`);
    }).finally(() => setDuplicating(false));
  }

  return (
    <div className="mx-auto max-w-3xl">
      <Link href="/organizer/events" className={textButtonClass}>
        {t.events.backToEvents}
      </Link>
      <h1 className="mt-3 text-2xl font-semibold">{event.title}</h1>
      <p className="mt-2 text-sm text-zinc-600">
        {event.venue_name} · {event.venue_address}
      </p>
      <p className="mt-1 text-sm text-zinc-500">
        {formatWhen(event.starts_at, locale)} — {formatWhen(event.ends_at, locale)}
      </p>
      <p className="mt-1 text-sm text-zinc-600">{t.organizerEvents[event.status]}</p>
      {error ? (
        <p role="alert" className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-700">
          {errorText(error, t)}
        </p>
      ) : null}

      {!cancelled ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => setEditEvent(!editEvent)}
          className={`mt-3 ${textButtonClass}`}
        >
          {editEvent ? t.events.cancel : t.events.editEvent}
        </button>
      ) : null}
      {editEvent ? <EventForm event={event} pending={pending} onSave={saveEvent} /> : null}

      <section className="mt-6 rounded-lg border border-zinc-200 bg-white p-5">
        <h2 className="font-medium">{t.events.ticketTypes}</h2>
        {ticketTypes.length === 0 ? (
          <p className="mt-3 text-sm text-zinc-600">{t.events.noTicketTypes}</p>
        ) : (
          <ul className="mt-3 divide-y divide-zinc-200">
            {ticketTypes.map((type) => (
              <li key={type.id} className="py-3">
                {editing === type.id ? (
                  <form onSubmit={(submission) => saveTicket(submission, type.id)}>
                    <fieldset disabled={pending} className="space-y-3">
                      <TicketFields type={type} />
                      <div className="flex items-center gap-3">
                        <button type="submit" className={buttonClass}>
                          {t.events.save}
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditing(null)}
                          className={textButtonClass}
                        >
                          {t.events.cancel}
                        </button>
                      </div>
                    </fieldset>
                  </form>
                ) : (
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium">{type.name}</p>
                      <p className="text-sm text-zinc-600">
                        {type.price === 0 ? t.common.free : priceFormatter.format(type.price / 100)}{' '}
                        · {type.quantity_total} {t.events.seats}
                        {type.is_hidden ? ` · ${t.events.hidden}` : ''}
                      </p>
                    </div>
                    {!cancelled ? (
                      <div className="flex items-center gap-3">
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => setEditing(type.id)}
                          className={textButtonClass}
                        >
                          {t.events.edit}
                        </button>
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => removeTicket(type.id)}
                          className={dangerClass}
                        >
                          {t.events.remove}
                        </button>
                      </div>
                    ) : null}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {!cancelled ? (
          <form onSubmit={saveTicket} className="mt-4 border-t border-zinc-200 pt-4">
            <fieldset disabled={pending} className="space-y-3">
              <legend className="mb-2 text-sm font-medium">{t.events.addTicketType}</legend>
              <TicketFields />
              <button type="submit" className={buttonClass}>
                {t.events.addBtn}
              </button>
            </fieldset>
          </form>
        ) : null}
      </section>

      <div className="mt-6 flex flex-wrap gap-3">
        {event.status === 'draft' ? (
          <button
            type="button"
            disabled={pending || ticketTypes.length === 0}
            onClick={() => changeStatus('publish')}
            className={buttonClass}
          >
            {t.events.publishBtn}
          </button>
        ) : null}
        {!cancelled ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => changeStatus('cancel')}
            className={dangerClass}
          >
            {t.events.cancelEventBtn}
          </button>
        ) : null}
        <button type="button" disabled={pending} onClick={duplicate} className={buttonClass}>
          {duplicating ? t.history.duplicating : t.history.duplicate}
        </button>
      </div>
      <div className="mt-4 flex flex-wrap gap-4">
        <Link href={`${eventPath}/timeline`} className={textButtonClass}>
          {t.history.timelineLink}
        </Link>
        <Link href={`${eventPath}/analytics`} className={textButtonClass}>
          {t.analytics.title}
        </Link>
        <Link href={`${eventPath}/orders`} className={textButtonClass}>
          {t.organizerOrders.title}
        </Link>
        <Link href={`${eventPath}/staff`} className={textButtonClass}>
          {t.staff.title}
        </Link>
        <Link href={`${eventPath}/promo`} className={textButtonClass}>
          {t.promo.title}
        </Link>
        <Link href={`${eventPath}/paid-sales`} className={textButtonClass}>
          {t.paidSales.title}
        </Link>
      </div>
    </div>
  );
}

export default function EventManagePage() {
  const { id } = useParams<{ id: string }>();
  return <EventLoader key={id} id={id} />;
}

function EventLoader({ id }: { id: string }) {
  const router = useRouter();
  const { t } = useI18n();
  const [event, setEvent] = useState<EventDetail | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    const token = readToken();
    if (!token) {
      router.replace(`/login?next=/organizer/events/${encodeURIComponent(id)}`);
      return;
    }
    let active = true;
    getManagedEvent(token, id)
      .then((result) => {
        if (active && readToken() === token) setEvent(result);
      })
      .catch((err: unknown) => {
        if (!active || readToken() !== token) return;
        if (err instanceof ApiError && err.status === 401) {
          clearSession();
          router.replace(`/login?next=/organizer/events/${encodeURIComponent(id)}`);
          return;
        }
        setError(err);
      });
    return () => {
      active = false;
    };
  }, [id, router]);

  if (error)
    return (
      <div className="mx-auto max-w-3xl">
        <Link href="/organizer/events" className={textButtonClass}>
          {t.events.backToEvents}
        </Link>
        <p role="alert" className="mt-4 text-sm text-red-700">
          {errorText(error, t)}
        </p>
      </div>
    );
  if (!event)
    return (
      <p role="status" className="text-sm text-zinc-600">
        {t.common.loading}
      </p>
    );
  return <EventManage initialEvent={event} />;
}
