// Public event reads. Shapes match docs/api.md. Money is tiyn (1 KZT = 100 tiyn).

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

async function apiGet<T>(path: string): Promise<T> {
  const url = `${apiBase()}${path}`;
  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    throw new ApiError(
      0,
      `Could not reach the API at ${apiBase()}. From the repo root, run: docker compose up -d, npm run migrate, npm run seed, npm run dev.`,
    );
  }

  if (!response.ok) {
    let message = `The API returned ${response.status}.`;
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      if (body.error?.message) message = body.error.message;
    } catch {
      // Not JSON. The status line above is enough.
    }
    throw new ApiError(response.status, message);
  }

  return (await response.json()) as T;
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
