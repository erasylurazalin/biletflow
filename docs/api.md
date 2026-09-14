# BiletFlow — API Contract

Starting point for discussion. Everything here is changeable — the point is to have
something concrete to argue about instead of a blank page.

Rule: if you need to change something in this file, say so in the group chat before
you change it. Silent changes are what break the other person's code.

---

## Conventions

- Base URL: `/api`
- JSON in, JSON out
- Auth: `Authorization: Bearer <token>` header
- IDs are UUID strings
- Timestamps are ISO 8601 UTC: `"2026-11-14T18:00:00Z"`
- Money is an integer in **tiyn** (1 KZT = 100 tiyn). `500000` = 5000 ₸.
  Avoids floating point rounding bugs. Frontend divides by 100 for display.
- Snake_case for JSON fields (pick one and stick to it — this is the pick)

### Errors

Every error looks the same:

```json
{
  "error": {
    "code": "TICKET_SOLD_OUT",
    "message": "No tickets remaining for this type"
  }
}
```

Status codes: `400` bad input, `401` not logged in, `403` logged in but not allowed,
`404` not found, `409` conflict (sold out, already checked in), `500` we broke it.

Frontend can show `message` directly. `code` is for logic.

---

## Auth

```
POST /api/auth/register    { email, password, name }        -> { user, token }
POST /api/auth/login       { email, password }              -> { user, token }
GET  /api/auth/me                                           -> { user }
```

```json
"user": {
  "id": "uuid",
  "email": "aidos@example.kz",
  "name": "Aidos",
  "role": "attendee" | "organizer" | "event_admin" | "platform_admin"
}
```

---

## Events

```
GET    /api/events                    public list (published only)
GET    /api/events/:id                public detail
POST   /api/events                    organizer creates
PATCH  /api/events/:id                organizer edits
POST   /api/events/:id/publish        draft -> published
```

```json
"event": {
  "id": "uuid",
  "title": "Astana Tech Meetup",
  "description": "...",
  "venue_name": "Nazarbayev University",
  "venue_address": "Kabanbay Batyr 53, Astana",
  "starts_at": "2026-11-14T18:00:00Z",
  "ends_at": "2026-11-14T21:00:00Z",
  "status": "draft" | "published" | "cancelled",
  "cover_image_url": "https://...",
  "organizer": { "id": "uuid", "name": "..." },
  "ticket_types": [ ... ]
}
```

The list endpoint returns events **without** `ticket_types` and with a shortened
description. Detail returns everything. Frontend should not assume list items are
complete.

---

## Ticket Types

```
POST   /api/events/:id/ticket-types
PATCH  /api/ticket-types/:id
DELETE /api/ticket-types/:id
```

```json
"ticket_type": {
  "id": "uuid",
  "name": "Early Bird",
  "price": 500000,
  "currency": "KZT",
  "quantity_total": 100,
  "quantity_available": 43,
  "sales_start_at": "...",
  "sales_end_at": "...",
  "is_hidden": false
}
```

`quantity_available` is computed by the backend. Frontend never calculates it.

---

## Orders (the important one)

Two steps: create the order, then pay for it. Do not merge these.

```
POST /api/orders          { event_id, items: [{ ticket_type_id, quantity }] }
                          -> { order }   // status: "pending"

POST /api/orders/:id/pay  { }            // fake payment for now
                          -> { order }   // status: "paid", tickets issued

GET  /api/orders                         // my orders
GET  /api/orders/:id
```

```json
"order": {
  "id": "uuid",
  "status": "pending" | "paid" | "cancelled" | "refunded",
  "event": { "id": "uuid", "title": "..." },
  "items": [
    { "ticket_type_id": "uuid", "name": "Early Bird", "quantity": 2, "unit_price": 500000 }
  ],
  "subtotal": 1000000,
  "discount": 0,
  "total": 1000000,
  "created_at": "...",
  "expires_at": "...",     // pending orders die after ~10 min
  "tickets": [ ... ]        // empty until paid
}
```

Inventory is held when the order is created, released when it expires.
`POST /orders` returns `409 TICKET_SOLD_OUT` if there isn't enough left.

Free tickets go through the same flow — `total` is just `0` and `/pay` succeeds
immediately. One code path, not two.

---

## Tickets

```
GET /api/tickets/:id
GET /api/tickets/:id/pdf     -> application/pdf
```

```json
"ticket": {
  "id": "uuid",
  "code": "BF-7K2M-9XQP",
  "status": "valid" | "checked_in" | "cancelled" | "refunded",
  "attendee_name": "Aidos K.",
  "ticket_type_name": "Early Bird",
  "event": { "id": "uuid", "title": "...", "starts_at": "...", "venue_name": "..." },
  "qr_payload": "BF1:uuid:signature"
}
```

**`qr_payload` is the string the QR image encodes.** This is the one field where
backend and the mobile app have to agree exactly. Format proposal:

```
BF1:<ticket_id>:<hmac_signature>
```

`BF1` = version prefix, so the scanner can reject anything that isn't ours —
including campaign/promo QR codes, which must never open the door.

The app sends the whole string back to the server. It does not parse or trust it.

---

## Check-in (mobile app)

```
GET  /api/staff/events                        events I'm assigned to
GET  /api/staff/events/:id/attendees          searchable list
POST /api/staff/check-in   { qr_payload }     -> { result, ticket }
POST /api/staff/check-in/:ticket_id/undo
```

```json
{
  "result": "valid" | "already_used" | "cancelled" | "refunded" | "not_found" | "wrong_event",
  "ticket": { ... },        // null if not_found
  "checked_in_at": "..."    // present when already_used
}
```

Always `200` unless the request itself is broken. A bad ticket is a normal
answer, not an HTTP error — the app shows a red screen, not a crash.

All validation is server-side. The phone decides nothing.

---

## Not specified yet

Promo codes, seat maps, support chat, analytics, refunds. We add these when we
get to them. Don't design them now.

---

## For the frontend people

Until the backend exists, build against fake data shaped exactly like the above.
Put it in one file (`src/mocks.ts`) so it's easy to rip out. Do not shape your
components around whatever the API happens to return later — shape them around
this document, and if the API disagrees, the API is wrong.
