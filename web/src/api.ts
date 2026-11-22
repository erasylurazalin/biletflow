// Public event reads and browser auth calls. Shapes match docs/api.md.
// Money is tiyn (1 KZT = 100 tiyn).

import type { Locale } from '@/i18n/config';
import { dictionaries } from '@/i18n';
import { formatDateTime, formatNumber } from '@/i18n/format';

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
  paid_sales_active: boolean;
  refund_policy: string | null;
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

export type SimulatedRefund = {
  amount: number;
  currency: string;
  is_demonstration: boolean;
  refunded_at: string;
};

export type OrderItem = {
  ticket_type_id: string;
  name: string;
  quantity: number;
  unit_price: number;
};

export type OrderTicket = {
  id: string;
  code: string;
  status: 'valid' | 'checked_in' | 'cancelled' | 'refunded';
  attendee_name: string;
  ticket_type_name: string;
  event: { id: string; title: string; starts_at: string; venue_name: string };
  qr_payload: string;
};

export type Ticket = OrderTicket;

export type Order = {
  id: string;
  status: 'pending' | 'paid' | 'cancelled' | 'refunded';
  event: { id: string; title: string };
  items: OrderItem[];
  subtotal: number;
  discount: number;
  processing_fee: number;
  total: number;
  promo: { code: string; campaign_name: string } | null;
  created_at: string;
  expires_at: string | null;
  payment: SimulatedPayment | null;
  refund: SimulatedRefund | null;
  tickets: OrderTicket[];
};

export type OrderListItem = Omit<Order, 'tickets'>;

// One order as the event's organizer sees it (docs/api.md "Refunds and cancellations").
export type OrganizerOrder = {
  id: string;
  status: 'pending' | 'paid' | 'cancelled' | 'refunded';
  buyer: { id: string; name: string; email: string };
  subtotal: number;
  discount: number;
  processing_fee: number;
  total: number;
  ticket_count: number;
  checked_in_count: number;
  created_at: string;
  refund: SimulatedRefund | null;
};

// One covered ticket type of a promo campaign, with what the event page needs to
// offer it once the code is applied (hidden types included).
export type PromoTicketType = {
  id: string;
  name: string;
  price: number;
  quantity_available: number;
};

// What GET /api/promo/:token answers for a campaign link.
export type PromoInfo = {
  code: string;
  event_id: string;
  campaign_name: string;
  discount_type: 'percent' | 'fixed';
  discount_value: number;
  ticket_type_ids: string[] | null;
  starts_at: string | null;
  ends_at: string | null;
  ticket_types: PromoTicketType[];
};

// One campaign as the event's organizer sees it, with the report numbers.
export type PromoCampaign = {
  id: string;
  event_id: string;
  name: string;
  code: string;
  token: string;
  discount_type: 'percent' | 'fixed';
  discount_value: number;
  starts_at: string | null;
  ends_at: string | null;
  max_redemptions: number | null;
  ticket_type_ids: string[] | null;
  is_active: boolean;
  created_at: string;
  link: string;
  redemptions: number;
  orders: number;
  tickets_sold: number;
  gross_revenue: number;
  discount_total: number;
  net_revenue: number;
};

// The event dashboard (docs/api.md "Analytics (organizer)"). Money is in tiyn and every
// revenue figure is demonstration money, like every payment (SRS 4.6).
export type EventAnalytics = {
  event: { id: string; title: string; status: string; starts_at: string };
  filters: { from: string | null; to: string | null; ticket_type_id: string | null };
  sales: {
    capacity: number;
    held: number;
    sold: number;
    remaining: number;
    percent_sold: number;
  };
  revenue: {
    currency: string;
    is_demonstration: boolean;
    gross: number;
    discounts: number;
    refunds: number;
    net: number;
  };
  by_ticket_type: {
    ticket_type_id: string;
    name: string;
    price: number;
    is_hidden: boolean;
    capacity: number;
    sold: number;
    remaining: number;
    gross: number;
    registered: number;
    checked_in: number;
    absent: number;
  }[];
  check_in: { registered: number; checked_in: number; absent: number; percent: number };
  over_time: {
    date: string;
    orders: number;
    tickets: number;
    gross: number;
    discounts: number;
    net: number;
  }[];
  campaigns: {
    id: string;
    name: string;
    code: string;
    is_active: boolean;
    redemptions: number;
    orders: number;
    tickets_sold: number;
    gross_revenue: number;
    discount_total: number;
    net_revenue: number;
  }[];
};

// A plain date (2026-10-20) means that whole day in Kazakhstan time, server side.
export type AnalyticsFilters = { from?: string; to?: string; ticket_type_id?: string };

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
  readonly code: string | null;

  constructor(status: number, message: string, code: string | null = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

function apiBase(): string {
  const configured = process.env.API_URL?.trim();
  return (configured || DEFAULT_API_URL).replace(/\/$/, '');
}

function unreachableMessage(): string {
  return `Could not reach the API at ${apiBase()}. From the repo root, run: docker compose up -d db, npm run migrate, npm run seed, npm run dev.`;
}

async function messageFromResponse(
  response: Response,
): Promise<{ message: string; code: string | null }> {
  let message = `The API returned ${response.status}.`;
  let code: string | null = null;
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string } };
    if (body.error?.message) message = body.error.message;
    if (body.error?.code) code = body.error.code;
  } catch {
    // Not JSON. The status line above is enough.
  }
  return { message, code };
}

async function apiGet<T>(path: string): Promise<T> {
  const url = `${apiBase()}${path}`;
  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    throw new ApiError(0, unreachableMessage(), 'API_UNREACHABLE');
  }

  if (!response.ok) {
    const { message, code } = await messageFromResponse(response);
    throw new ApiError(response.status, message, code);
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
    throw new ApiError(0, unreachableMessage(), 'API_UNREACHABLE');
  }

  if (!response.ok) {
    const { message, code } = await messageFromResponse(response);
    throw new ApiError(response.status, message, code);
  }

  // Successful DELETE responses have no JSON body to parse.
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export async function createOrder(
  token: string,
  eventId: string,
  items: { ticket_type_id: string; quantity: number; attendee_names?: string[] }[],
  promoCode?: string,
): Promise<Order> {
  const body = await apiSend<{ order: Order }>('/api/orders', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event_id: eventId,
      items,
      ...(promoCode && { promo_code: promoCode }),
    }),
  });
  return body.order;
}

export async function listMyTickets(token: string): Promise<Ticket[]> {
  const body = await apiSend<{ tickets: Ticket[] }>('/api/tickets?limit=100', {
    headers: { Authorization: `Bearer ${token}` },
  });
  return body.tickets;
}

// The printable ticket (docs/api.md "Printable ticket (PDF)"). Same-origin path, so
// next.config.ts rewrites it to the API and the browser never needs API_URL.
export async function downloadTicketPdf(ticketId: string, token: string): Promise<Blob> {
  let response: Response;
  try {
    response = await fetch(`/api/tickets/${encodeURIComponent(ticketId)}/pdf`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    throw new ApiError(0, unreachableMessage(), 'API_UNREACHABLE');
  }

  if (!response.ok) {
    const { message, code } = await messageFromResponse(response);
    throw new ApiError(response.status, message, code);
  }

  return response.blob();
}

export async function listMyOrders(token: string): Promise<OrderListItem[]> {
  const body = await apiSend<{ orders: OrderListItem[] }>('/api/orders?limit=100', {
    headers: { Authorization: `Bearer ${token}` },
  });
  return body.orders;
}

export async function getOrder(token: string, orderId: string): Promise<Order> {
  const body = await apiSend<{ order: Order }>(`/api/orders/${encodeURIComponent(orderId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return body.order;
}

export async function payOrder(
  token: string,
  orderId: string,
  simulateFailure = false,
): Promise<Order> {
  const body = await apiSend<{ order: Order }>(`/api/orders/${encodeURIComponent(orderId)}/pay`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(simulateFailure ? { simulate_failure: true } : {}),
  });
  return body.order;
}

export async function listEventOrders(eventId: string, token: string): Promise<OrganizerOrder[]> {
  const body = await apiSend<{ orders: OrganizerOrder[] }>(
    `/api/events/${encodeURIComponent(eventId)}/orders?limit=100`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  return body.orders;
}

export async function getEventAnalytics(
  eventId: string,
  token: string,
  filters: AnalyticsFilters = {},
): Promise<EventAnalytics> {
  const params = new URLSearchParams();
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  if (filters.ticket_type_id) params.set('ticket_type_id', filters.ticket_type_id);
  const search = params.toString();
  return apiSend<EventAnalytics>(
    `/api/events/${encodeURIComponent(eventId)}/analytics${search ? `?${search}` : ''}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
}

export async function refundOrder(
  eventId: string,
  orderId: string,
  token: string,
): Promise<OrganizerOrder> {
  const body = await apiSend<{ order: OrganizerOrder }>(
    `/api/events/${encodeURIComponent(eventId)}/orders/${encodeURIComponent(orderId)}/refund`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
  );
  return body.order;
}

export async function cancelRegistration(
  eventId: string,
  orderId: string,
  token: string,
): Promise<OrganizerOrder> {
  const body = await apiSend<{ order: OrganizerOrder }>(
    `/api/events/${encodeURIComponent(eventId)}/orders/${encodeURIComponent(orderId)}/cancel`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
  );
  return body.order;
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

export function verifyOrganizerIdentity(token: string): Promise<{ organizer_profile: OrganizerProfile }> {
  return apiSend('/api/me/organizer-profile/verify-identity', {
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

export type PromoCampaignInput = {
  name: string;
  discount_type: 'percent' | 'fixed';
  discount_value: number;
  code?: string;
  starts_at?: string;
  ends_at?: string;
  max_redemptions?: number;
  ticket_type_ids?: string[] | null;
};

// The event's ticket types (hidden ones included) come back with the list, because
// the create form offers them and the public event detail leaves hidden types out.
export type PromoCampaignListResponse = {
  campaigns: PromoCampaign[];
  ticket_types: { id: string; name: string; price: number; is_hidden: boolean }[];
  limit: number;
  offset: number;
};

export async function listPromoCampaigns(
  eventId: string,
  token: string,
): Promise<PromoCampaignListResponse> {
  return apiSend<PromoCampaignListResponse>(
    `/api/events/${encodeURIComponent(eventId)}/promo-campaigns?limit=100`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
}

export async function createPromoCampaign(
  eventId: string,
  input: PromoCampaignInput,
  token: string,
): Promise<PromoCampaign> {
  const body = await apiSend<{ campaign: PromoCampaign }>(
    `/api/events/${encodeURIComponent(eventId)}/promo-campaigns`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
  );
  return body.campaign;
}

export async function setPromoCampaignActive(
  campaignId: string,
  isActive: boolean,
  token: string,
): Promise<PromoCampaign> {
  const body = await apiSend<{ campaign: PromoCampaign }>(
    `/api/promo-campaigns/${encodeURIComponent(campaignId)}`,
    {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_active: isActive }),
    },
  );
  return body.campaign;
}

// Public: what a campaign link promises. 404 PROMO_CAMPAIGN_NOT_FOUND for a dead link.
export async function getPromoByToken(token: string): Promise<PromoInfo> {
  const body = await apiGet<{ promo: PromoInfo }>(`/api/promo/${encodeURIComponent(token)}`);
  return body.promo;
}

// ---------------------------------------------------------------------------
// Organizer pages (SRS 4.2, 4.3, UC1): become an organizer, my events,
// create/edit an event, ticket types, publish and cancel.
// ---------------------------------------------------------------------------

export type OrganizerEvent = EventListItem & {
  phase: EventPhase;
  capacity: number;
  tickets_sold: number;
  checked_in: number;
};

export type EventPhase = 'draft' | 'cancelled' | 'upcoming' | 'active' | 'completed';

export type AuditEntry = {
  id: string;
  created_at: string;
  action: string;
  entity_type: string;
  entity_id: string;
  description: string;
  actor: { id: string; name: string } | null;
};

export type EventTimelineResponse = {
  entries: AuditEntry[];
  actions: string[];
  limit: number;
  offset: number;
};

export type TimelineFilters = {
  from?: string;
  to?: string;
  action?: string;
};

export type MyEventsResponse = {
  events: OrganizerEvent[];
  limit: number;
  offset: number;
};

type EventFields = Omit<EventDetail, 'paid_sales_active' | 'ticket_types'>;

export type CreateEventInput = {
  title: string;
  description: string;
  venue_name: string;
  venue_address: string;
  starts_at: string;
  ends_at: string;
  cover_image_url?: string | null;
  refund_policy?: string | null;
};

export type TicketTypeInput = {
  name: string;
  price: number;
  currency?: 'KZT';
  quantity_total: number;
  sales_start_at?: string | null;
  sales_end_at?: string | null;
  is_hidden?: boolean;
};

export type OrganizerProfileInput = {
  display_name: string;
  contact_email: string | null;
  contact_phone: string | null;
  payout: {
    bank_name: string;
    iban: string;
    account_holder: string;
  } | null;
};

export function listMyEvents(token: string, offset: number): Promise<MyEventsResponse> {
  return apiSend<MyEventsResponse>(`/api/me/events?offset=${offset}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
}

export function getEventTimeline(
  token: string,
  id: string,
  filters: TimelineFilters,
  offset: number,
): Promise<EventTimelineResponse> {
  const params = new URLSearchParams();
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  if (filters.action) params.set('action', filters.action);
  params.set('offset', String(offset));
  return apiSend<EventTimelineResponse>(
    `/api/events/${encodeURIComponent(id)}/timeline?${params.toString()}`,
    { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' },
  );
}

export async function duplicateEvent(token: string, id: string): Promise<{ event: EventDetail }> {
  return apiSend<{ event: EventDetail }>(
    `/api/events/${encodeURIComponent(id)}/duplicate`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
  );
}

export async function getManagedEvent(token: string, id: string): Promise<EventDetail> {
  const body = await apiSend<{ event: EventDetail }>(
    `/api/events/${encodeURIComponent(id)}/manage`,
    { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' },
  );
  return body.event;
}

export async function getOrganizerProfile(token: string): Promise<{ organizer_profile: OrganizerProfile }> {
  const body = await apiSend<{ organizer_profile: OrganizerProfile }>(
    '/api/me/organizer-profile',
    { headers: { Authorization: `Bearer ${token}` } },
  );
  return body;
}

export type OrganizerProfile = {
  user_id: string;
  display_name: string;
  contact_email: string | null;
  contact_phone: string | null;
  payout: { bank_name: string; iban: string; account_holder: string } | null;
  identity_verified_at: string | null;
  created_at: string;
  updated_at: string;
};

export async function createOrganizerProfile(
  token: string,
  input: OrganizerProfileInput,
): Promise<{ organizer_profile: OrganizerProfile; user: Omit<User, 'email_verified'>; token: string }> {
  const body = await apiSend<{ organizer_profile: OrganizerProfile; user: Omit<User, 'email_verified'>; token: string }>(
    '/api/me/organizer-profile',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
  );
  return body;
}

export async function patchOrganizerProfile(
  token: string,
  input: Partial<OrganizerProfileInput>,
): Promise<{ organizer_profile: OrganizerProfile }> {
  const body = await apiSend<{ organizer_profile: OrganizerProfile }>(
    '/api/me/organizer-profile',
    {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
  );
  return body;
}

export async function createEvent(token: string, input: CreateEventInput): Promise<{ event: EventFields }> {
  const body = await apiSend<{ event: EventFields }>('/api/events', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return body;
}

export async function updateEvent(
  token: string,
  id: string,
  input: Partial<CreateEventInput>,
): Promise<{ event: EventFields }> {
  const body = await apiSend<{ event: EventFields }>(`/api/events/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return body;
}

export async function publishEvent(token: string, id: string): Promise<{ event: EventFields }> {
  const body = await apiSend<{ event: EventFields }>(
    `/api/events/${encodeURIComponent(id)}/publish`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
  );
  return body;
}

export async function cancelEvent(token: string, id: string): Promise<{ event: EventFields }> {
  const body = await apiSend<{ event: EventFields }>(
    `/api/events/${encodeURIComponent(id)}/cancel`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
  );
  return body;
}

export async function createTicketType(
  eventId: string,
  token: string,
  input: TicketTypeInput,
): Promise<{ ticket_type: TicketType }> {
  const body = await apiSend<{ ticket_type: TicketType }>(
    `/api/events/${encodeURIComponent(eventId)}/ticket-types`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
  );
  return body;
}

export async function updateTicketType(
  token: string,
  id: string,
  input: Partial<TicketTypeInput>,
): Promise<{ ticket_type: TicketType }> {
  const body = await apiSend<{ ticket_type: TicketType }>(
    `/api/ticket-types/${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
  );
  return body;
}

export async function deleteTicketType(token: string, id: string): Promise<void> {
  await apiSend<void>(`/api/ticket-types/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
}

// ---------------------------------------------------------------------------
// Platform administration (SRS 4.12, issue #63). Every call needs a
// platform_admin token; the API answers 403 for every other role.
// ---------------------------------------------------------------------------

export type AdminUser = {
  id: string;
  email: string;
  name: string;
  role: User['role'];
  email_verified: boolean;
  suspended: boolean;
  suspended_at: string | null;
  suspended_by: string | null;
  created_at: string;
};

export type AdminEvent = {
  id: string;
  title: string;
  status: 'draft' | 'published' | 'cancelled';
  suspended: boolean;
  suspended_at: string | null;
  starts_at: string;
  ends_at: string;
  organizer: { id: string; name: string; email: string };
  open_reports: number;
};

export type AdminReportStatus = 'open' | 'dismissed' | 'actioned';

export type AdminReport = {
  id: string;
  event: {
    id: string;
    title: string;
    status: 'draft' | 'published' | 'cancelled';
    suspended: boolean;
  };
  reported_by: { id: string; name: string; email: string };
  reason: string;
  status: AdminReportStatus;
  created_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
};

export type AdminOrder = {
  id: string;
  status: Order['status'];
  buyer: { id: string; name: string; email: string };
  event: { id: string; title: string };
  subtotal: number;
  discount: number;
  processing_fee: number;
  total: number;
  created_at: string;
  payment: SimulatedPayment | null;
  refund: SimulatedRefund | null;
  failed_payment_attempts: number;
  last_payment_failed_at: string | null;
};

export type AdminSettings = {
  activation_fee: number;
  currency: string;
  updated_at: string;
  updated_by: string | null;
};

function adminQuery(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

export async function searchAdminUsers(
  token: string,
  q: string,
  offset = 0,
): Promise<{ users: AdminUser[]; limit: number; offset: number }> {
  return apiSend(`/api/admin/users${adminQuery({ q, limit: 100, offset })}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function setAdminUserSuspended(
  userId: string,
  suspend: boolean,
  token: string,
): Promise<AdminUser> {
  const body = await apiSend<{ user: AdminUser }>(
    `/api/admin/users/${encodeURIComponent(userId)}/${suspend ? 'suspend' : 'unsuspend'}`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
  );
  return body.user;
}

export async function searchAdminEvents(
  token: string,
  filters: { q?: string; status?: string; offset?: number } = {},
): Promise<{ events: AdminEvent[]; limit: number; offset: number }> {
  return apiSend(
    `/api/admin/events${adminQuery({
      q: filters.q,
      status: filters.status,
      limit: 100,
      offset: filters.offset ?? 0,
    })}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
}

export async function setAdminEventSuspended(
  eventId: string,
  suspend: boolean,
  token: string,
): Promise<{ id: string; suspended: boolean }> {
  const body = await apiSend<{ event: { id: string; suspended: boolean } }>(
    `/api/admin/events/${encodeURIComponent(eventId)}/${suspend ? 'suspend' : 'unsuspend'}`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
  );
  return body.event;
}

export async function reportEvent(
  eventId: string,
  reason: string,
  token: string,
): Promise<AdminReport> {
  const body = await apiSend<{ report: AdminReport }>(
    `/api/events/${encodeURIComponent(eventId)}/report`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    },
  );
  return body.report;
}

export async function listAdminReports(
  token: string,
  status: AdminReportStatus = 'open',
): Promise<AdminReport[]> {
  const body = await apiSend<{ reports: AdminReport[] }>(
    `/api/admin/reports${adminQuery({ status, limit: 100 })}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  return body.reports;
}

export async function resolveAdminReport(
  reportId: string,
  action: 'dismiss' | 'suspend',
  token: string,
): Promise<AdminReport> {
  const body = await apiSend<{ report: AdminReport }>(
    `/api/admin/reports/${encodeURIComponent(reportId)}/resolve`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    },
  );
  return body.report;
}

export async function getAdminSettings(token: string): Promise<AdminSettings> {
  const body = await apiSend<{ settings: AdminSettings }>('/api/admin/settings', {
    headers: { Authorization: `Bearer ${token}` },
  });
  return body.settings;
}

export async function updateAdminSettings(
  activationFee: number,
  token: string,
): Promise<AdminSettings> {
  const body = await apiSend<{ settings: AdminSettings }>('/api/admin/settings', {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ activation_fee: activationFee }),
  });
  return body.settings;
}

export async function searchAdminOrders(
  token: string,
  filters: { q?: string; status?: string; offset?: number } = {},
): Promise<{ orders: AdminOrder[]; limit: number; offset: number }> {
  return apiSend(
    `/api/admin/orders${adminQuery({
      q: filters.q,
      status: filters.status,
      limit: 100,
      offset: filters.offset ?? 0,
    })}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
}

// The CSV endpoints answer a file, so this is the blob variant of apiSend. The browser
// fetches it with the token and saves it, which a plain link cannot do.
export async function downloadAdminCsv(
  kind: 'orders' | 'refunds',
  token: string,
  filters: { q?: string; status?: string } = {},
): Promise<Blob> {
  let response: Response;
  try {
    response = await fetch(
      `/api/admin/export/${kind}.csv${adminQuery({ q: filters.q, status: filters.status })}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
  } catch {
    throw new ApiError(0, unreachableMessage(), 'API_UNREACHABLE');
  }

  if (!response.ok) {
    const { message, code } = await messageFromResponse(response);
    throw new ApiError(response.status, message, code);
  }
  return response.blob();
}

export function formatPrice(tiyn: number, locale: Locale): string {
  if (tiyn === 0) return dictionaries[locale].common.free;
  return formatMoney(tiyn, locale);
}

// Money for figures that are not a ticket price: revenue of 0 is "0 ₸", not "Free"
// (formatPrice is for ticket types, where 0 means the ticket costs nothing).
export function formatMoney(tiyn: number, locale: Locale): string {
  return `${formatNumber(Math.round(tiyn / 100), locale)} ₸`;
}

export function formatWhen(iso: string, locale: Locale): string {
  return formatDateTime(iso, locale);
}
