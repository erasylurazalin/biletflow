import { ApiError } from '@/api';
import type { Dictionary } from './index';

// What to show for a failed request. The API's messages are English, so codes whose
// message varies (it names the ticket type) get one sentence of their own, exact
// messages come from the apiMessages map, and anything else stays in English.
export function errorText(err: unknown, t: Dictionary): string {
  if (!(err instanceof ApiError)) return t.common.genericError;
  if (err.code === 'API_UNREACHABLE') return t.errors.unreachable;
  if (err.code === 'TICKET_SOLD_OUT') return t.errors.soldOut || err.message;
  if (err.code === 'SALES_CLOSED') return t.errors.salesClosed || err.message;
  return t.apiMessages[err.message] ?? err.message;
}
