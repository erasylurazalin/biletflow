// Fake data shaped like docs/api.md. Rip this file out when the API is live.

export type TicketType = {
  id: string;
  name: string;
  price: number;
  currency: 'KZT';
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
  status: 'published';
  cover_image_url: string;
  organizer: { id: string; name: string };
};

export type EventDetail = EventListItem & {
  ticket_types: TicketType[];
};

const ORGANIZER = { id: '11111111-1111-4111-8111-111111111111', name: 'Aigerim S.' };

export const events: EventDetail[] = [
  {
    id: '33333333-3333-4333-8333-333333333333',
    title: 'Astana Tech Meetup',
    description: 'Monthly meetup for developers in Astana. Three talks, then pizza and questions.',
    venue_name: 'Nazarbayev University',
    venue_address: 'Kabanbay Batyr 53, Astana',
    starts_at: '2026-11-14T18:00:00Z',
    ends_at: '2026-11-14T21:00:00Z',
    status: 'published',
    cover_image_url: 'https://picsum.photos/seed/biletflow-tech/800/450',
    organizer: ORGANIZER,
    ticket_types: [
      {
        id: '55555555-5555-4555-8555-555555555555',
        name: 'Early Bird',
        price: 500000,
        currency: 'KZT',
        quantity_total: 100,
        quantity_available: 43,
        sales_start_at: null,
        sales_end_at: null,
        is_hidden: false,
      },
      {
        id: '66666666-6666-4666-8666-666666666666',
        name: 'Student',
        price: 0,
        currency: 'KZT',
        quantity_total: 50,
        quantity_available: 50,
        sales_start_at: null,
        sales_end_at: null,
        is_hidden: false,
      },
    ],
  },
  {
    id: '44444444-4444-4444-8444-444444444444',
    title: 'Almaty Jazz Night',
    description: 'Local quartet playing standards and a few originals. Doors open an hour early.',
    venue_name: 'Almaty Philharmonic',
    venue_address: 'Kaldayakov 35, Almaty',
    starts_at: '2026-11-29T18:00:00Z',
    ends_at: '2026-11-29T22:00:00Z',
    status: 'published',
    cover_image_url: 'https://picsum.photos/seed/biletflow-jazz/800/450',
    organizer: ORGANIZER,
    ticket_types: [
      {
        id: '77777777-7777-4777-8777-777777777777',
        name: 'Standard',
        price: 1200000,
        currency: 'KZT',
        quantity_total: 200,
        quantity_available: 200,
        sales_start_at: null,
        sales_end_at: null,
        is_hidden: false,
      },
    ],
  },
];

export function listEvents(): EventListItem[] {
  return events.map((event) => ({
    id: event.id,
    title: event.title,
    description: event.description,
    venue_name: event.venue_name,
    venue_address: event.venue_address,
    starts_at: event.starts_at,
    ends_at: event.ends_at,
    status: event.status,
    cover_image_url: event.cover_image_url,
    organizer: event.organizer,
  }));
}

export function getEvent(id: string): EventDetail | undefined {
  return events.find((event) => event.id === id);
}

// API money is tiyn. 1 KZT = 100 tiyn.
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
