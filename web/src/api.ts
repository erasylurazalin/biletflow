// Public event reads and browser auth calls. Shapes match docs/api.md.
// Money is tiyn (1 KZT = 100 tiyn).

const DEFAULT_API_URL = 'http://127.0.0.1:3000';

export type TicketType = {
  id: string;
  name: string;
  price: number;
  currency: string;
  quantity_total: number;
  quantity_available: number;
  sales_start_at: string | null;
  sales_end_at: string | null;
  is_hidden: boolean;
};

export type EventListItem = {
  id: string;
  title: string;
  description: string;
  venue_name: string;
  venue_address: string;
  starts_at: string;
  ends_at: string;
  status: 'draft' | 'published' | 'cancelled';
  cover_image_url: string | null;
  organizer: { id: string; name: string };
};

export type EventDetail = EventListItem & {
  ticket_types: TicketType[];
};

type EventListResponse = {
  events: EventListItem[];
  limit: number;
  offset: number;
};

export type User = {
  id: string;
  email: string;
  name: string;
  role: 'attendee' | 'organizer' | 'event_admin' | 'platform_admin';
  email_verified: boolean;
};

export type AuthSession = {
  user: User;
  token: string;
};

export type InboxEmail = {
  id: string;
  kind: string;
  subject: string;
  body: string;
  created_at: string;
};

export type SimulatedPayment = {
  method: 'simulated';
  is_demonstration: boolean;
  amount: number;
  currency: string;
  paid_at: string;
};

export type PaidSales = {
  event_id: string;
  status: 'inactive' | 'active';
  checklist: {
    paid_ticket_type: boolean;
    identity_verified: boolean;
    payout_account: boolean;
    activation_fee_paid: boolean;
    terms_accepted: boolean;
  };
  activation_fee: {
    amount: number;
    currency: string;
    payment: SimulatedPayment | null;
  };
  terms_accepted_at: string | null;
  activated_at: string | null;
};

export type PayoutInput = {
  bank_name: string;
  iban: string;
  account_holder: string;
};

export type StaffMember = { id: string; email: string; name: string; assigned_at: string };

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

function apiBase(): string {
  const configured = process.env.API_URL?.trim();
  return (configured || DEFAULT_API_URL).replace(/\/$/, '');
}

function unreachableMessage(): string {
  return `Could not reach the API at ${apiBase()}. From the repo root, run: docker compose up -d, npm run migrate, npm run seed, npm run dev.`;
}

async function messageFromResponse(response: Response): Promise<string> {
  let message = `The API returned ${response.status}.`;
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    if (body.error?.message) message = body.error.message;
  } catch {
    // Not JSON. The status line above is enough.
  }
  return message;
}

async function apiGet<T>(path: string): Promise<T> {
  const url = `${apiBase()}${path}`;
  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    throw new ApiError(0, unreachableMessage());
  }

  if (!response.ok) {
    throw new ApiError(response.status, await messageFromResponse(response));
  }

  return (await response.json()) as T;
}

// Browser auth calls use a same-origin path. next.config.ts rewrites /api/* to the
// API, because the API does not send CORS headers and API_URL stays server-only.
async function apiSend<T>(path: string, init: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new ApiError(0, unreachableMessage());
  }

  if (!response.ok) {
    throw new ApiError(response.status, await messageFromResponse(response));
  }

  // Successful DELETE responses have no JSON body to parse.
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function registerAccount(input: {
  name: string;
  email: string;
  password: string;
}): Promise<AuthSession> {
  return apiSend<AuthSession>('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export function loginAccount(input: { email: string; password: string }): Promise<AuthSession> {
  return apiSend<AuthSession>('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export async function getMe(token: string): Promise<User> {
  const body = await apiSend<{ user: User }>('/api/auth/me', {
    headers: { Authorization: `Bearer ${token}` },
  });
  return body.user;
}

export async function verifyEmail(token: string): Promise<User> {
  const body = await apiSend<{ user: User }>('/api/auth/verify-email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  return body.user;
}

export async function resendVerification(token: string): Promise<void> {
  await apiSend<{ sent: boolean }>('/api/auth/verify-email/resend', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function requestPasswordReset(email: string): Promise<void> {
  await apiSend<{ sent: boolean }>('/api/auth/password-reset/request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
}

export function confirmPasswordReset(token: string, password: string): Promise<AuthSession> {
  return apiSend<AuthSession>('/api/auth/password-reset/confirm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, password }),
  });
}

export async function listMyEmails(authToken: string): Promise<InboxEmail[]> {
  const body = await apiSend<{ emails: InboxEmail[] }>('/api/me/emails', {
    headers: { Authorization: `Bearer ${authToken}` },
  });
  return body.emails;
}

export async function listDevOutbox(email: string): Promise<InboxEmail[]> {
  const body = await apiSend<{ emails: InboxEmail[] }>(
    `/api/dev/outbox?email=${encodeURIComponent(email)}`,
    {},
  );
  return body.emails;
}

export async function getPaidSales(eventId: string, token: string): Promise<PaidSales> {
  const body = await apiSend<{ paid_sales: PaidSales }>(
    `/api/events/${encodeURIComponent(eventId)}/paid-sales`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  return body.paid_sales;
}

async function mutatePaidSales(
  eventId: string,
  step: 'activation-fee' | 'terms' | 'activate',
  token: string,
  input?: { accepted: true },
): Promise<PaidSales> {
  const body = await apiSend<{ paid_sales: PaidSales }>(
    `/api/events/${encodeURIComponent(eventId)}/paid-sales/${step}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input ?? {}),
    },
  );
  return body.paid_sales;
}

export function payActivationFee(eventId: string, token: string): Promise<PaidSales> {
  return mutatePaidSales(eventId, 'activation-fee', token);
}

export function acceptPaidSalesTerms(eventId: string, token: string): Promise<PaidSales> {
  return mutatePaidSales(eventId, 'terms', token, { accepted: true });
}

export function activatePaidSales(eventId: string, token: string): Promise<PaidSales> {
  return mutatePaidSales(eventId, 'activate', token);
}

export async function listStaff(eventId: string, token: string): Promise<StaffMember[]> {
  const body = await apiSend<{ staff: StaffMember[] }>(
    `/api/events/${encodeURIComponent(eventId)}/staff?limit=100`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  return body.staff;
}

export async function assignStaff(
  eventId: string,
  email: string,
  token: string,
): Promise<StaffMember> {
  const body = await apiSend<{ staff_member: StaffMember }>(
    `/api/events/${encodeURIComponent(eventId)}/staff`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email }),
    },
  );
  return body.staff_member;
}

export async function removeStaff(eventId: string, userId: string, token: string): Promise<void> {
  await apiSend<void>(
    `/api/events/${encodeURIComponent(eventId)}/staff/${encodeURIComponent(userId)}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
  );
}

export async function verifyOrganizerIdentity(token: string): Promise<void> {
  await apiSend('/api/me/organizer-profile/verify-identity', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function savePayoutAccount(token: string, payout: PayoutInput): Promise<void> {
  await apiSend('/api/me/organizer-profile', {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ payout }),
  });
}

export async function listEvents(): Promise<EventListItem[]> {
  const body = await apiGet<EventListResponse>('/api/events');
  return body.events;
}

export async function getEvent(id: string): Promise<EventDetail> {
  const body = await apiGet<{ event: EventDetail }>(`/api/events/${encodeURIComponent(id)}`);
  return body.event;
}

export function formatPrice(tiyn: number): string {
  if (tiyn === 0) return 'Free';
  return `${Math.round(tiyn / 100).toLocaleString('ru-KZ')} ₸`;
}

export function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString('ru-KZ', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Almaty',
  });
}
