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
POST /api/auth/register              { email, password, name } -> { user, token }
POST /api/auth/login                 { email, password }       -> { user, token }
GET  /api/auth/me                                                -> { user }
POST /api/auth/verify-email          { token }                 -> { user }
POST /api/auth/verify-email/resend                             -> { sent: true }
```

```json
"user": {
  "id": "uuid",
  "email": "aidos@example.kz",
  "name": "Aidos",
  "role": "attendee" | "organizer" | "event_admin" | "platform_admin",
  "email_verified": false
}
```

Everyone registers as `attendee` with `email_verified: false`. Registration sends a
verification link that is valid for 24 hours and can be used once. `verify-email` needs
no auth token; an invalid, expired or used link is `400 INVALID_TOKEN`. `resend` requires
auth and sends a fresh link unless the email is already verified (`409 CONFLICT`).

Creating an organizer profile (below) is what turns a user into an `organizer`. The role
lives in the token, so after it changes the client uses the new token: the one
`POST /api/me/organizer-profile` returns, or one from a fresh login.

---

## Email (simulated)

Email is simulated for the academic MVP (SRS 3.2 and 4.6 allow simulations). Every
message is written to the `email_outbox` table and one line is logged without the body.
The outbox contains the recipients, subjects and bodies a real provider would receive.

`GET /api/me/emails` requires auth and returns the caller's simulated inbox, matched by
email case-insensitively, newest first and limited to 50 messages:

```json
{
  "emails": [
    {
      "id": "uuid",
      "kind": "verify_email",
      "subject": "Confirm your BiletFlow email",
      "body": "...verification link...",
      "created_at": "..."
    }
  ]
}
```

---

## Organizer profile

Becoming an organizer is self-service: no approval, but the caller's email must be
verified. Identity verification is a separate, later step that only gates paid ticket
sales. It never blocks creating events.

```
POST  /api/me/organizer-profile   { display_name, contact_email?, contact_phone?, payout? }
                                  -> { organizer_profile, user, token }
GET   /api/me/organizer-profile   -> { organizer_profile }
PATCH /api/me/organizer-profile   { any of the POST fields } -> { organizer_profile }
POST  /api/me/organizer-profile/verify-identity   { } -> { organizer_profile }
```

```json
"organizer_profile": {
  "user_id": "uuid",
  "display_name": "Astana Tech Community",
  "contact_email": "hello@astanatech.kz" | null,
  "contact_phone": "+77011234567" | null,
  "payout": {                          // or null when no payout account is set
    "bank_name": "Demo Bank",
    "iban": "KZ000000000000000000",
    "account_holder": "Aidos K."
  },
  "identity_verified_at": "..." | null,   // simulated, see below
  "created_at": "...",
  "updated_at": "..."
}
```

All four need a token, and all four work on the caller's own profile only.

- `POST` creates the profile and switches the caller's role to `organizer`. A
  `platform_admin` keeps their role. It answers `201` with the updated `user` and a new
  `token` carrying the new role. An unverified email is `403 EMAIL_NOT_VERIFIED`. A second
  `POST` is `409 CONFLICT`: edit with `PATCH`.
- `display_name` is required, and at least one of `contact_email` and `contact_phone`.
  The phone is in international format and is stored without spaces or dashes:
  `"+7 (701) 123-45-67"` becomes `"+77011234567"`. The email is stored lower-cased.
- `payout` is optional. When sent, it needs all three fields; the IBAN is stored
  upper-case without spaces. **Payout details are demonstration data**: payouts are
  simulated in the academic MVP, so the IBAN shape is checked but nothing is ever paid.
- `PATCH` changes only the fields sent. `null` clears `contact_email`, `contact_phone`
  or `payout`, but the profile must keep at least one contact (`400` otherwise).
- `verify-identity` is a **simulated identity check** (SRS 3.2 step 2): it takes nothing,
  stores no document numbers and always succeeds. It sets `identity_verified_at` once;
  calling it again changes nothing and answers `200`. It is one of the steps of paid
  sales activation (below).
- `GET`, `PATCH` or `verify-identity` without a profile is
  `404 ORGANIZER_PROFILE_NOT_FOUND`.

---

## Events

```
GET    /api/events                    public list (published only)
GET    /api/events/:id                public detail
POST   /api/events                    organizer creates (role organizer: has a profile)
PATCH  /api/events/:id                organizer edits
POST   /api/events/:id/publish        draft -> published
POST   /api/events/:id/cancel         draft or published -> cancelled
```

- Only the event's organizer can publish or cancel it. Unknown events return
  `404 EVENT_NOT_FOUND`; other organizers get `403`.
- Publishing requires at least one ticket type and a future start time. Published and
  cancelled events cannot be published again (`409 CONFLICT`).
- Cancelling an already cancelled event returns `409 CONFLICT`. Cancellation also cancels
  every valid ticket and every pending order. Checked-in tickets and paid orders are unchanged.

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
  "paid_sales_active": false,
  "ticket_types": [ ... ]
}
```

`paid_sales_active` says whether ticket types with a price above `0` can be bought
(see "Paid sales activation"). When it is `false`, show paid types as not on sale yet.

The list endpoint returns events **without** `ticket_types` and `paid_sales_active`, and with a shortened
description. Detail returns everything. Frontend should not assume list items are
complete.

### List responses

Every list endpoint wraps its array in an envelope that echoes the paging used:

```json
{
  "events": [ ... ],
  "limit": 20,
  "offset": 0
}
```

Paging comes from the query string: `GET /api/events?limit=50&offset=50`. `limit`
defaults to 20 and caps at 100, `offset` defaults to 0. `q` filters on the title.

The array key is the plural of what is listed (`events`, `orders`, `tickets`), so a
client always reads `body.events` and never a bare array. This is our pick, not a
standard: agreed in the group chat, and implemented in `GET /api/events`.

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

Buying needs a logged-in user of any role, not the `attendee` role: organizers and
door staff go to other people's events too.

```
POST /api/orders          { event_id, items: [{ ticket_type_id, quantity }] }
                          -> { order }   // status: "pending"

POST /api/orders/:id/pay  { }            // simulated payment
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
  "expires_at": "...",     // pending orders die after 15 min; null once paid
  "payment": { ... } | null, // null until paid, and for free orders
  "tickets": [ ... ]        // empty until paid
}
```

```json
"payment": {
  "method": "simulated",
  "is_demonstration": true,
  "amount": 1000000,
  "currency": "KZT",
  "paid_at": "..."
}
```

**Every payment is demonstration data** (SRS 4.6). No money moves. `is_demonstration`
is always `true` in the academic MVP, and clients must show it, for example as a
"Demo payment" badge, and never present the payment as a real transaction.

Inventory is held when the order is created, released when it expires.
`POST /orders` returns `409 TICKET_SOLD_OUT` if there isn't enough left.

Free tickets go through the same flow: `total` is just `0` and `/pay` succeeds
immediately, with no `payment` record. One code path, not two.

### Creating an order

All four need a token.

- `items` has at least one entry, and each `ticket_type_id` appears once. `quantity` is
  a whole number from 1 to 10, and the whole order is at most 10 tickets (SRS 4.3 asks
  for a per-order limit; a limit the organizer sets comes later). Anything else is
  `400 VALIDATION_ERROR`.
- The event must be published. A draft or a missing event is `404 EVENT_NOT_FOUND`,
  the same as the public detail. A cancelled event is `409 CONFLICT`.
- Every ticket type must belong to that event and must not be hidden, otherwise
  `400 VALIDATION_ERROR`. Hidden types become buyable with promo codes, which are not
  specified yet.
- Outside a ticket type's `sales_start_at` and `sales_end_at` the order is
  `409 SALES_CLOSED`. Not enough left is `409 TICKET_SOLD_OUT`.
- `name` and `unit_price` are copied from the ticket type into the order, so a later
  price change does not touch it. `subtotal` is the sum of the items, `discount` is
  `0` until promo codes exist, and `total` is `subtotal - discount`.
- `expires_at` is 15 minutes after `created_at` (the SRS gives no time; this is our
  default, `docs/decisions.md`). A pending order past that time holds no inventory and
  reads as `cancelled`.
- A ticket type with a price above `0` can only be ordered once the event's paid sales
  are active (SRS 4.5). Before that it is `409 PAID_SALES_INACTIVE`. Free types on the
  same event can always be ordered.

### Paying and reading orders

- Orders belong to the buyer. Somebody else's order is `404 ORDER_NOT_FOUND`, not
  `403`, so ids of other people's orders cannot be probed.
- `/pay` on a pending order marks it `paid` and issues one ticket per admission: an
  item with `quantity: 2` gives two tickets. The order comes back with its `tickets`
  and, when `total` is above `0`, its simulated `payment`. It takes no card details.
  On an expired order it is `409 ORDER_EXPIRED`. On a paid or cancelled order it is
  `409 CONFLICT`.
- Each ticket's `attendee_name` is the buyer's account name for now. SRS 4.6 wants
  attendee details at checkout; per-ticket names are a later addition to the request
  body.
- `GET /api/orders` ("my orders") uses the list envelope: `{ orders, limit, offset }`,
  newest first, every status. List items leave out `tickets`; `GET /api/orders/:id`
  has them.

---

## Paid sales activation (organizer)

Free tickets need nothing. Selling paid tickets on an event needs paid sales activated
for that event first (SRS 3.2, 4.5, UC2). The organizer works through a checklist and
then activates. Activation applies to that one event only.

```
GET  /api/events/:id/paid-sales                  -> { paid_sales }
POST /api/events/:id/paid-sales/activation-fee   { }                  -> { paid_sales }
POST /api/events/:id/paid-sales/terms            { accepted: true }   -> { paid_sales }
POST /api/events/:id/paid-sales/activate         { }                  -> { paid_sales }
```

```json
"paid_sales": {
  "event_id": "uuid",
  "status": "inactive" | "active",
  "checklist": {
    "paid_ticket_type": true,       // the event has a ticket type with a price above 0
    "identity_verified": true,      // POST /api/me/organizer-profile/verify-identity
    "payout_account": true,         // payout set on the organizer profile
    "activation_fee_paid": false,   // POST .../activation-fee
    "terms_accepted": false         // POST .../terms
  },
  "activation_fee": {
    "amount": 500000,               // 5,000 KZT
    "currency": "KZT",
    "payment": { ... } | null       // the "payment" object from Orders
  },
  "terms_accepted_at": "..." | null,
  "activated_at": "..." | null
}
```

All four need a token and are for the event's organizer only: anyone else gets
`403 FORBIDDEN`, and a missing event is `404 EVENT_NOT_FOUND`. On a cancelled event the
three `POST`s are `409 CONFLICT`.

- Identity and the payout account belong to the organizer, so they are done once on the
  organizer profile and count for every event. The fee and the terms are per event.
- `activation-fee` records a **simulated payment** of the fee. The amount is 5,000 KZT
  (SRS 3.3 leaves it open; `docs/decisions.md`). Paying it a second time is
  `409 CONFLICT`.
- `terms` needs `{ "accepted": true }`, anything else is `400`. Accepting again changes
  nothing.
- `activate` checks the whole checklist at that moment. Anything missing is
  `409 PAID_SALES_INCOMPLETE`, and the message names what is missing. Activating an
  event that is already active changes nothing and answers `200`.
- The steps can be done in any order, on a draft or a published event.
- Activation is not undone by later edits, for example removing the payout account.
  Suspending paid sales (SRS 4.5, platform admins) is not specified yet.

---

## Tickets

```
GET /api/tickets             my tickets -> { tickets, limit, offset }
GET /api/tickets/:id
GET /api/tickets/:id/pdf     -> application/pdf
```

All three need a token and show only tickets from the caller's own orders. Anyone
else's ticket is `404 TICKET_NOT_FOUND`. `GET /api/tickets` lists tickets in every
status, soonest event first, with the same item shape as below.

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
backend and the mobile app have to agree exactly. The format:

```
BF1:<ticket_id>:<hmac_signature>
BF1:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb:3aCMMhEA4oqbvzq1cElUe_EbD_aItVWk7NSjPnZSHIw
```

- `BF1` is the version prefix, so the scanner can reject anything that isn't ours,
  including Campaign QR Codes, which must never open the door (SRS 4.14).
- `ticket_id` is the ticket's UUID, lower-case.
- `hmac_signature` is HMAC-SHA256 over `BF1:<ticket_id>` with the server's secret,
  in base64url without padding: always 43 characters.

`src/lib/qr.ts` signs and verifies it. The payload is not stored: the server computes
it whenever it returns a ticket, so changing the secret invalidates every old QR code.

The app sends the whole string back to the server. It does not parse or trust it.

---

## Staff assignments (organizer)

The organizer puts people on the door of their event. Being assigned is what makes a
user that event's admin: any registered user can be assigned (the organizer too), and
assigning does not change their `role`.

```
POST   /api/events/:id/staff            { email }   -> { staff_member }
GET    /api/events/:id/staff                        -> { staff, limit, offset }
DELETE /api/events/:id/staff/:userId                -> 204
```

```json
"staff_member": {
  "id": "uuid",              // the user's id, which is what DELETE takes
  "email": "dana@example.kz",
  "name": "Dana",
  "assigned_at": "2026-10-01T09:00:00Z"
}
```

All three need a token, and all three are for the event's organizer only: anyone else
gets `403 FORBIDDEN`, and a missing event is `404 EVENT_NOT_FOUND`.

- `POST` looks the email up case-insensitively. No account with that email is
  `404 USER_NOT_FOUND`: the person has to register first. A new assignment answers
  `201`. Assigning somebody who is already assigned is not an error: it answers `200`
  with the existing assignment and changes nothing.
- `GET` is a list endpoint with the usual `limit` and `offset`, oldest assignment first.
- `DELETE` answers `404 NOT_FOUND` when that user is not on the event's staff.

---

## Check-in (mobile app)

```
GET  /api/staff/events                        events I'm assigned to
GET  /api/staff/events/:id/attendees          searchable list
POST /api/staff/check-in   { event_id, qr_payload } -> { result, ticket }
POST /api/staff/check-in/:ticket_id/undo
```

A check-in ticket has this shape wherever a ticket is returned by these endpoints:

```json
{
  "id": "...",
  "code": "BF-7K2M-9XQP",
  "status": "valid" | "checked_in" | "cancelled" | "refunded",
  "attendee_name": "...",
  "ticket_type_name": "...",
  "checked_in_at": "..." | null
}
```

```json
{
  "result": "valid" | "already_used" | "cancelled" | "refunded" | "invalid" | "not_found" | "wrong_event",
  "ticket": { ... },        // null if invalid, not_found or wrong_event
  "checked_in_at": "..."    // present when already_used
}
```

`invalid` means the scanned string is not a ticket we signed: a Campaign QR Code, some
other QR code, or a forged or damaged payload. `not_found` means the signature is
right but no such ticket exists, which in practice means the database was reset after
the ticket was issued. `wrong_event` means the ticket belongs to another event; its
attendee details are not returned.

`GET /api/staff/events` means the events this person is assigned to, and assignments
live in the `event_staff` table (migration 002): one row per event and user, written
when an organizer puts somebody on the door. Role `event_admin` alone opens no event,
and being the organizer does not by itself count as an assignment. An unassigned staff
member gets an empty list, and check-in, undo and the attendees list require assignment
to the ticket's event, otherwise they return `403`.

`GET /api/staff/events` uses the list envelope (`{ events, limit, offset }`) and the
same item shape as `GET /api/events`, soonest first. It lists events in every status,
not only published ones: staff can be put on the door before the event is published,
and a cancelled event shows up as `"cancelled"` instead of vanishing from the app.

`GET /api/staff/events/:id/attendees` accepts the usual `limit` and `offset`, plus an
optional `q` of at most 100 trimmed characters. Search matches `attendee_name` or
`code`, case-insensitively. The list contains `valid` and `checked_in` tickets, ordered
by attendee name and then ticket id:

```json
{
  "attendees": [
    {
      "id": "...",
      "code": "...",
      "status": "valid",
      "attendee_name": "...",
      "ticket_type_name": "...",
      "checked_in_at": null
    }
  ],
  "counts": { "registered": 2, "checked_in": 1 },
  "limit": 20,
  "offset": 0
}
```

The counts cover the whole event, ignoring search and paging. `registered` counts both
`valid` and `checked_in` tickets; `checked_in` counts only checked-in tickets.

Undo requires a ticket currently in `checked_in` status. A missing ticket is
`404 TICKET_NOT_FOUND`; any other status is `409 CONFLICT`. Success restores `valid`,
clears the check-in timestamp and staff member, and returns `200 { "ticket": { ... } }`.
Successful check-in and undo write audit entries; other scan results do not.

Scan results are always `200` unless the request itself is broken. A bad ticket is a
normal answer, not an HTTP error: the app shows a red screen, not a crash.

All validation is server-side. The phone decides nothing.

---

## Audit log

Not an endpoint yet. Every organizer, admin, payment and refund action writes one entry
(SRS 4.9, 4.16, 7), and the event timeline (#62) will read them. Write entries with
`recordAudit(client, entry)` from `src/lib/audit.ts`, using the transaction client, so
the entry and the change commit or roll back together. Entries can't be edited or
deleted: the table refuses both.

An entry has a timestamp, the acting user (null for the system), an action, the entity
it's about, the event when there is one, and a short English description like
`"Price changed from 5000 to 6000 KZT"`.

Use these action names and no others. A new one goes into this table and into
`AUDIT_ACTIONS` in `src/lib/audit.ts`, in the same PR.

| Action                                | Entity            | When                                                            |
| ------------------------------------- | ----------------- | --------------------------------------------------------------- |
| `event.created`                       | event             | an organizer creates an event                                   |
| `event.updated`                       | event             | an organizer edits event details                                |
| `event.published`                     | event             | a draft goes live                                               |
| `event.cancelled`                     | event             | an organizer cancels the event                                  |
| `event.deleted`                       | event             | a draft is deleted                                              |
| `event.duplicated`                    | event             | a past event is copied into a new draft (entity is the new one) |
| `event.suspended`                     | event             | a platform admin suspends the event                             |
| `event.unsuspended`                   | event             | a platform admin lifts the suspension                           |
| `ticket_type.created`                 | ticket_type       | a ticket type is added                                          |
| `ticket_type.updated`                 | ticket_type       | price, capacity or sale dates change                            |
| `ticket_type.deleted`                 | ticket_type       | a ticket type is removed                                        |
| `staff.assigned`                      | user              | someone is put on the door (entity is that user)                |
| `staff.removed`                       | user              | someone is taken off the door                                   |
| `organizer_profile.identity_verified` | organizer_profile | the simulated identity check passes (no event)                  |
| `paid_sales.fee_paid`                 | payment           | the activation fee is paid                                      |
| `paid_sales.activated`                | event             | paid sales are switched on                                      |
| `order.paid`                          | order             | an order is paid, or a free one confirmed                       |
| `order.payment_failed`                | order             | a simulated payment fails                                       |
| `order.cancelled`                     | order             | an order is cancelled, by a person or by expiring (actor null)  |
| `order.refunded`                      | order             | an organizer refunds an order                                   |
| `ticket.checked_in`                   | ticket            | a ticket is scanned at the door                                 |
| `ticket.check_in_reversed`            | ticket            | a check-in is undone                                            |
| `promo_code.created`                  | promo_code        | a promo code is created                                         |
| `promo_code.disabled`                 | promo_code        | a promo code is switched off                                    |
| `support_case.status_changed`         | support_case      | a support case changes status                                   |
| `user.suspended`                      | user              | a platform admin suspends an account (no event)                 |
| `user.unsuspended`                    | user              | a platform admin lifts it                                       |

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
