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
POST /api/auth/password-reset/request  { email }               -> { sent: true }
POST /api/auth/password-reset/confirm  { token, password }     -> { user, token }
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

Password reset needs no auth. `password-reset/request` always answers `{ "sent": true }`,
whether the account exists or not. For an existing account it sends a link that is valid
for 1 hour. `password-reset/confirm` accepts a non-empty token and a password with the same
rules as registration. It updates the password, verifies the email if needed and invalidates
all other unused reset links. The link can be used once; an invalid, expired or used token is
`400 INVALID_TOKEN`. Success returns `{ user, token }` so the client can log in immediately.

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

`GET /api/dev/outbox?email=<email>` returns the same email items, order and 50-message
limit for the given address, without auth. It is **development only** so a logged-out user
can retrieve a password-reset link from the simulated inbox. Because it exposes anyone's
emails, it returns `404 NOT_FOUND` when `NODE_ENV=production`. A missing or invalid email
is `400` outside production.

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
GET    /api/events                    public list (published, not suspended)
GET    /api/events/:id                public detail (404 once suspended)
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
  "refund_policy": "Tickets are refundable in full until the event starts.",
  "ticket_types": [ ... ]
}
```

`paid_sales_active` says whether ticket types with a price above `0` can be bought
(see "Paid sales activation"). When it is `false`, show paid types as not on sale yet.

`refund_policy` is optional free text, at most 2000 characters, shown to attendees
under a "Refund policy" heading on the event page. It is information only: nothing
enforces it, and refunds work the same way with no policy set. Set and clear it
through `POST /api/events` and `PATCH /api/events/:id` (`null` clears). It appears in
every full event response (detail, create, update, publish, cancel), not in the list.

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

## Admin: suspending an event

```
POST /api/admin/events/:id/suspend      -> { event }
POST /api/admin/events/:id/unsuspend    -> { event }
```

For `platform_admin` only (SRS 4.12). Everybody else logged in gets `403 FORBIDDEN`, and
no token is `401`. Unknown events return `404 EVENT_NOT_FOUND`. Suspending an event that
is already suspended, or lifting a suspension that is not there, is `409 CONFLICT`.

A suspended event:

- disappears from `GET /api/events`, and `GET /api/events/:id` answers `404 EVENT_NOT_FOUND`;
- takes no new orders: `POST /api/orders` answers `409 CONFLICT`
  ("This event is not accepting orders");
- keeps everything that already exists. Orders and tickets are not cancelled, refunded or
  hidden from their owners, and an order placed before the suspension can still be paid.

Suspension sits on top of the organizer's `status` and never changes it, so lifting it
puts the event back exactly as it was. Suspending and lifting each write an audit entry
(`event.suspended`, `event.unsuspended`).

```json
"event": {
  "id": "uuid",
  "title": "Astana Tech Meetup",
  "status": "published",
  "suspended": true,
  "suspended_at": "2026-10-25T12:00:00Z"
}
```

`suspended_at` is `null` when `suspended` is `false`. This is only the admin's answer:
the full event object does not carry the flag yet. Searching events, suspending users,
reported events, platform settings and the admin pages are #63.

---

## Orders (the important one)

Two steps: create the order, then pay for it. Do not merge these.

Buying needs a logged-in user of any role, not the `attendee` role: organizers and
door staff go to other people's events too.

```
POST /api/orders          { event_id, items: [{ ticket_type_id, quantity, attendee_names? }], promo_code? }
                          -> { order }   // status: "pending"

POST /api/orders/:id/pay  { simulate_failure? } // simulated payment
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
  "processing_fee": 30000,
  "total": 1030000,
  "promo": { "code": "SPRING25", "campaign_name": "Spring deal" } | null,
  "created_at": "...",
  "expires_at": "...",     // pending orders die after 15 min; null once paid
  "payment": { ... } | null, // null until paid, and for free orders
  "refund": { ... } | null,  // null unless the organizer refunded the order
  "tickets": [ ... ]        // empty until paid
}
```

```json
"refund": {
  "method": "simulated",
  "is_demonstration": true,
  "amount": 1030000,
  "currency": "KZT",
  "refunded_at": "..."
}
```

**Every refund is demonstration data**, like every payment (SRS 4.6). No money moves.
`is_demonstration` is always `true` in the academic MVP, and clients must show it,
for example as "Refunded 10,300 ₸ (simulated)". The attendee sees the refund through
`GET /api/orders/:id`; the organizer starts it with the endpoints below.

```json
"payment": {
  "method": "simulated",
  "is_demonstration": true,
  "amount": 1030000,
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
- An item may include `attendee_names`, with exactly one name per ticket in its
  `quantity`. Each name is trimmed and must be 1 to 100 characters. A missing list is
  allowed; a list of the wrong length is `400 VALIDATION_ERROR`.
- The event must be published. A draft or a missing event is `404 EVENT_NOT_FOUND`,
  the same as the public detail. A cancelled event is `409 CONFLICT`, and so is an event
  a platform admin has suspended (see "Admin: suspending an event").
- Every ticket type must belong to that event and must not be hidden, otherwise
  `400 VALIDATION_ERROR`. A hidden type is orderable only with a promo code whose
  campaign lists that type explicitly in `ticket_type_ids` (see "Promo codes and
  campaign QR codes"); without such a code it stays `400 VALIDATION_ERROR`.
- `promo_code` is optional. When given, it is matched case-insensitively and validated
  inside the same transaction that creates the order. Every refusal is
  `409 PROMO_CODE_INVALID` (see "Promo codes and campaign QR codes").
- Outside a ticket type's `sales_start_at` and `sales_end_at` the order is
  `409 SALES_CLOSED`. Not enough left is `409 TICKET_SOLD_OUT`.
- `name` and `unit_price` are copied from the ticket type into the order, so a later
  price change does not touch it. `subtotal` is the sum of the items. `discount` is
  `0` without a promo code, and the promo discount when a valid one is given (see
  "Promo codes and campaign QR codes"). `processing_fee` is 3% of
  `subtotal - discount`, rounded to the nearest tiyn. `total` is
  `subtotal - discount + processing_fee`, so the fee and total are both `0` for a free
  order, including an order whose promo discount covers its whole subtotal. The
  simulated payment uses `total`.
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
- Each ticket takes its `attendee_name` from the item's `attendee_names`, in seat order.
  Without that list, it uses the buyer's account name.
- Successful payment writes an `order.paid` audit entry and sends the buyer an
  `order_confirmation` email. It lists every ticket code, type and attendee name, and
  links to `/tickets` for the QR codes. A paid order also states the simulated total and
  that no real money was charged.
- The optional boolean `simulate_failure` demonstrates a failed payment when `total` is
  above `0`. The response is `402 PAYMENT_FAILED`, the order stays pending, and no
  tickets or payment are created. The committed `order.payment_failed` audit entry and
  `payment_failed` email explain that no money was taken and link back to the order so
  the buyer can try again. The flag is ignored for a free order. Other body fields are
  ignored.
- `GET /api/orders` ("my orders") uses the list envelope: `{ orders, limit, offset }`,
  newest first, every status. List items leave out `tickets`; `GET /api/orders/:id`
  has them.

---

## Refunds and cancellations (organizer)

The organizer refunds a paid order in full (simulated) or cancels a free registration.
No partial refunds, no attendee-initiated refunds (docs/decisions.md, decision 10).

```
GET  /api/events/:id/orders                       -> { orders, limit, offset }
POST /api/events/:id/orders/:orderId/refund       -> { order }
POST /api/events/:id/orders/:orderId/cancel       -> { order }
```

All three need a token and are for the event's organizer only: anyone else gets
`403 FORBIDDEN`, and a missing event is `404 EVENT_NOT_FOUND`. An order that is not
this event's is `404 ORDER_NOT_FOUND`, so order ids cannot be probed through an
event's URL. They work on published and cancelled events alike: an organizer who
called off an event refunds its paid orders afterwards.

```json
"order": {
  "id": "uuid",
  "status": "pending" | "paid" | "cancelled" | "refunded",
  "buyer": { "id": "uuid", "name": "...", "email": "..." },
  "subtotal": 1000000,
  "discount": 0,
  "processing_fee": 30000,
  "total": 1030000,
  "ticket_count": 2,
  "checked_in_count": 0,
  "created_at": "...",
  "refund": { ... } | null
}
```

`GET /api/events/:id/orders` uses the list envelope, newest first, every status, with
the optional `status` query parameter (`pending`, `paid`, `cancelled` or `refunded`)
to filter. `ticket_count` is all of the order's tickets; `checked_in_count` counts
only checked-in ones. There are no `items` and no `tickets` here: the buyer's own
order endpoint has those.

- Only orders with status `paid` qualify. A `pending`, `cancelled` or `refunded`
  order is `409 CONFLICT`.
- The endpoints check the order's total: refund on a free registration (`total = 0`)
  and cancel on a paid order are both `409 CONFLICT`, with a message naming the other
  endpoint as the right action.
- If any ticket of the order was already used at the door (`checked_in`), the whole
  action is `409 CONFLICT` ("Some tickets of this order were already used at the
  door") and nothing changes.
- Refund: the order becomes `refunded`, its tickets in status `valid` or `cancelled`
  become `refunded`, and one row is written to the `refunds` table (migration 008),
  one per order. Cancel: the order becomes `cancelled`, its `valid` tickets become
  `cancelled`.
- Seats return to inventory through the ordinary availability query: an order that is
  `refunded` or `cancelled` holds no seats. No other mechanism runs.
- Scanning a refunded or cancelled ticket at the door answers
  `result: "refunded"` or `"cancelled"` (see "Check-in").
- Both actions write an audit entry (`order.refunded` with the simulated amount,
  `order.cancelled` with the ticket count) and email the buyer: `refund_completed`
  with the amount, the note that it is simulated and the event's `refund_policy` when
  one is set, or `registration_cancelled` for a free registration.
- Two simultaneous refunds of one order: exactly one succeeds, the other gets the
  `409 CONFLICT`. The order row is locked and re-checked inside the transaction.

---

## Promo codes and campaign QR codes (organizer)

A promotional campaign belongs to one event and gives a discount on the ticket types
it covers (SRS 4.14, UC10). Each campaign carries a promo `code` the buyer types at
checkout and an opaque `token` that goes into the campaign link. The QR code is a
picture of exactly that link, in dark blue on white so it never looks like the black
admission tickets on the same phone, and it is not a ticket: the check-in endpoint
answers `invalid` for it (see "Check-in").

```
POST /api/events/:id/promo-campaigns        { campaign } fields below -> 201 { campaign }
GET  /api/events/:id/promo-campaigns        -> { campaigns, ticket_types, limit, offset }
PATCH /api/promo-campaigns/:id              { is_active }             -> { campaign }
GET  /api/promo-campaigns/:id/qr.png        -> image/png (organizer only)
GET  /api/promo/:token                      -> { promo } (public)
```

The first three need a token and are for the event's organizer only: anyone else gets
`403 FORBIDDEN`, and a missing event is `404 EVENT_NOT_FOUND`. A campaign id that
does not exist is `404 PROMO_CAMPAIGN_NOT_FOUND`. The public `GET /api/promo/:token`
answers the same `404 PROMO_CAMPAIGN_NOT_FOUND` when the token is unknown or the
campaign is not currently usable (inactive, before `starts_at`, after `ends_at`).

```json
"campaign": {
  "id": "uuid",
  "event_id": "uuid",
  "name": "Spring deal",
  "code": "SPRING25",
  "token": "base64url, 32 characters",
  "discount_type": "percent" | "fixed",
  "discount_value": 20,
  "starts_at": "..." | null,
  "ends_at": "..." | null,
  "max_redemptions": 100,        // or null: unlimited
  "ticket_type_ids": ["uuid"] | null,  // null: every ticket type of the event
  "is_active": true,
  "created_at": "...",
  "link": "https://<web>/events/<event id>?promo=<token>",
  "redemptions": 0,
  "orders": 0,
  "tickets_sold": 0,
  "gross_revenue": 0,
  "discount_total": 0,
  "net_revenue": 0
}
```

- Creating takes `name` (1 to 100 characters), `discount_type` with `discount_value`
  (`percent` is 1 to 100, `fixed` is an amount in tiyn above 0), and optionally `code`
  (6 to 20 characters of A-Z and 0-9, any case; stored upper-case and unique across
  the platform; left out, the server generates 8 random characters), `starts_at`,
  `ends_at` (`ends_at` must be after `starts_at` when both are set), `max_redemptions`
  and `ticket_type_ids` (every id must belong to the event, hidden types included).
  Creating writes a `promo_code.created` audit entry.
- `PATCH` takes `{ "is_active": false }` (or `true`). Turning a campaign off writes a
  `promo_code.disabled` audit entry; turning it back on writes none.
- The campaign link never contains the discount or any price: only the event id and
  the opaque token. `GET /api/promo-campaigns/:id/qr.png` is a PNG of that link,
  generated on the server.
- The report numbers are computed from the database on every read, never stored.
  `redemptions` counts live redemptions: an order that is `paid`, or `pending` and not
  expired, the same rule as seat availability. Abandoned orders free their redemption,
  and so do refunds and cancellations. `orders`, `tickets_sold` and `gross_revenue`
  (the sum of `subtotal`) count paid orders only; `discount_total` is the sum of the
  discounts of paid orders and `net_revenue` is `gross_revenue - discount_total`.
  Processing fees are not revenue for the organizer and are left out.
- `GET /api/events/:id/promo-campaigns` uses the list envelope, newest first. Its
  response also carries the event's `ticket_types` (hidden ones included, with
  `id`, `name`, `price`, `is_hidden`), because the create form offers them and the
  public event detail leaves hidden types out.

```json
"promo": {
  "code": "SPRING25",
  "event_id": "uuid",
  "campaign_name": "Spring deal",
  "discount_type": "percent",
  "discount_value": 20,
  "ticket_type_ids": ["uuid"] | null,
  "starts_at": "..." | null,
  "ends_at": "..." | null,
  "ticket_types": [
    { "id": "uuid", "name": "Early Bird", "price": 500000, "quantity_available": 43 }
  ]
}
```

The web event page calls `GET /api/promo/:token` when it is opened with
`?promo=<token>`, pre-fills the promo field with the code and shows which types are
covered, hidden ones included: `ticket_types` lists the covered types with name, price
and availability so they can be ordered like any other type once the code is applied.

### Redeeming a code

`POST /api/orders` takes an optional `promo_code`, matched case-insensitively. It is
validated and applied in the same transaction that creates the order, under a lock on
the campaign row, so the redemption limit holds when many buyers check out at once.
Exactly one code per order.

The discount covers only the items whose ticket type the campaign covers (the
"applicable subtotal"). `percent` is `round(applicable * percent / 100)`; `fixed` is
`min(value, applicable)`, once per order. Then `processing_fee` is 3% of
`subtotal - discount` and `total = subtotal - discount + processing_fee`, as always:
the processing charge is never discounted. A `total` of 0 is allowed and behaves like
a free order at payment. Paid ticket types still need the event's paid sales to be
active, with or without a code.

Every refusal is `409 PROMO_CODE_INVALID`, with `message` shown to the buyer:

| Situation                                   | Message                                                  |
| ------------------------------------------- | -------------------------------------------------------- |
| Unknown code, or a code of another event    | `This promo code is not valid`                           |
| The campaign is not active                  | `This promo code is no longer active`                    |
| Before `starts_at`                          | `This promo code is not active yet`                      |
| After `ends_at`                             | `This promo code has expired`                            |
| The redemption limit is reached             | `This promo code has been fully used`                    |
| None of the ordered ticket types is covered | `This promo code does not apply to the selected tickets` |

The order records its campaign, and one row per order is written to
`promo_redemptions` with the discount amount. `order.promo` carries
`{ code, campaign_name }` of that campaign, or `null`.

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

### Printable ticket (PDF)

`GET /api/tickets/:id/pdf` answers `application/pdf`: a one-page A4 ticket the attendee
prints from any viewer (SRS 4.11, UC7, criterion 4). It needs a token and is for the
ticket's owner only: anybody else's ticket is `404 TICKET_NOT_FOUND`, the same as
`GET /api/tickets/:id`. A plain bad id is `400 VALIDATION_ERROR`.

The response carries `Content-Disposition: attachment; filename="biletflow-<code>.pdf"`.

Every status prints, `cancelled` and `refunded` included: the status is on the page and
the QR code is the ticket's own `qr_payload`, so a printed copy and the phone are one
admission and the door scanner decides what is valid, exactly as it does for the app.

The page carries the event title, its date and time in Kazakhstan time, the venue name
and address, the ticket type, the attendee name, the ticket code, the ticket's status,
and the QR code, and nothing else. It carries no price, no payment data, no currency and
no email address (SRS 4.11).

The QR code is black on white with a quiet zone, at least 60 mm square, at error
correction level Q, so a grayscale print on ordinary A4 still decodes. The PDF is
generated from the ticket record on every request, by `src/lib/ticket-pdf.ts`, with an
embedded DejaVu font so Kazakh and Russian event and attendee names print correctly.

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

## Analytics (organizer)

The event dashboard (SRS 4.15, UC11, success criterion 10), read from orders, order
items, tickets, refunds, redemptions and check-ins on every request. Nothing is
stored: a stored counter would drift the first time a refund or an undone check-in
happened.

```
GET /api/events/:id/analytics?from=&to=&ticket_type_id=
    -> { event, filters, sales, revenue, by_ticket_type, check_in, over_time, campaigns }
```

Needs a token and is for the event's organizer only: anyone else gets `403 FORBIDDEN`,
and a missing event is `404 EVENT_NOT_FOUND`. Draft, published and cancelled events
all answer: an organizer looks at the numbers before the event and after calling it
off. A filter narrows every block except `campaigns`, which is described below.

Every query parameter is optional:

- `from` and `to` are ISO 8601 date-times with an offset, or plain dates
  (`2026-10-20`). They narrow on the order's `created_at`. `from` is inclusive and
  `to` is exclusive, so a plain date covers that whole day in Kazakhstan time
  (`Asia/Almaty`, UTC+5, no daylight saving), the same rule as the day buckets below.
  `from` at or after `to` is `400 VALIDATION_ERROR`.
- `ticket_type_id` narrows the numbers to one ticket type of this event. A type that
  does not exist or belongs to another event is `400 VALIDATION_ERROR`, not `404`, so
  the parameter cannot be used to probe other events.

```json
{
  "event": { "id": "uuid", "title": "...", "status": "published", "starts_at": "..." },
  "filters": { "from": "..." | null, "to": "..." | null, "ticket_type_id": "uuid" | null },
  "sales": { "capacity": 200, "held": 4, "sold": 52, "remaining": 148, "percent_sold": 26.0 },
  "revenue": {
    "currency": "KZT",
    "is_demonstration": true,
    "gross": 26000000,
    "discounts": 1300000,
    "refunds": 2600000,
    "net": 22100000
  },
  "by_ticket_type": [
    {
      "ticket_type_id": "uuid",
      "name": "Early Bird",
      "price": 500000,
      "is_hidden": false,
      "capacity": 100,
      "sold": 30,
      "remaining": 70,
      "gross": 15000000,
      "registered": 28,
      "checked_in": 20,
      "absent": 8
    }
  ],
  "check_in": { "registered": 40, "checked_in": 31, "absent": 9, "percent": 77.5 },
  "over_time": [
    { "date": "2026-10-20", "orders": 3, "tickets": 7, "gross": 3500000,
      "discounts": 350000, "net": 3150000 }
  ],
  "campaigns": [
    { "id": "uuid", "name": "Spring deal", "code": "SPRING25", "is_active": true,
      "redemptions": 12, "orders": 9, "tickets_sold": 18,
      "gross_revenue": 9000000, "discount_total": 1800000, "net_revenue": 7200000 }
  ]
}
```

Every money figure is an integer in tiyn.

**Sales.** `capacity` is the sum of the ticket types' `quantity_total`, hidden types
included; with `ticket_type_id` it is that one type's. `sold` counts the tickets of
paid orders, so a refund or a cancellation takes its tickets back out and a pending
order is not a sale yet. `held` is the seats in pending orders that have not expired:
the public detail's `quantity_available` is `capacity - sold - held`, while
`remaining` here is `capacity - sold`. `percent_sold` is `sold / capacity` in percent,
one decimal, and `0` when capacity is `0`. With a date range, `sold` counts the tickets
paid for in that range and `remaining` is capacity minus that figure, so leave the
range empty for the inventory picture.

**Revenue.** `gross` is the sum of `subtotal` over every order that reached paid,
refunded ones included; `discounts` is the sum of their `discount`; `refunds` is the
sum of `subtotal - discount` over the refunded ones; and `net` is
`gross - discounts - refunds`, the money the organizer keeps. These are order-level
figures: with `ticket_type_id` they count the orders that include at least one ticket
of that type, in full, because a discount belongs to the whole order. The figures are
demonstration money like every payment (SRS 4.6), and clients label them so. The 3%
processing fee is not organizer revenue (decision 5): it is not in `gross`, and a
refund hands it back to the attendee without appearing here, so `refunds` is smaller
than the `amount` the refunds endpoint records, by exactly that fee.

**By ticket type.** One row per ticket type of the event, hidden ones included, in
the public detail's order (price, then name); with `ticket_type_id`, that one row.
`sold` and `gross` come from the order items of paid orders, where `gross` is the
recorded `unit_price` times `quantity`, before discounts. A discount is recorded per
order and not per item, so it is not split across types: `revenue.discounts` is the
only discount figure.

**Attendance.** `registered` counts tickets in status `valid` or `checked_in`,
`checked_in` counts the scanned ones, `absent` the ones still waiting, and `percent`
is `checked_in / registered` in percent, one decimal, `0` when nothing is registered.
Refunded and cancelled tickets are in none of the three: their holders gave them up
before the door. The same numbers read correctly before the event, when they simply
say nobody has been scanned yet.

**Sales over time.** One entry per day with orders, oldest first, bucketed by the
local (`Asia/Almaty`) day of the order's `created_at`; days without orders are left
out instead of being filled with zeros. `orders` and `tickets` count the orders
created that day that reached paid, refunded included, and `net` is
`gross - discounts`. Refunds are not bucketed by day: a refund happens on a different
day than the sale, so it shows in `revenue` only.

**Campaigns.** The same numbers `GET /api/events/:id/promo-campaigns` reports, newest
first, computed by the same helper. They are campaign lifetime figures and are not
narrowed by `from` or `to`; with `ticket_type_id` the list keeps the campaigns that
cover that type, and a campaign with no `ticket_type_ids` covers every type. A
campaign report counts paid orders that stand, so `gross_revenue` there and
`revenue.gross` here can differ: one measures redemptions, the other money.

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

Seat maps, support chat. We add these when we
get to them. Don't design them now.

---

## For the frontend people

Until the backend exists, build against fake data shaped exactly like the above.
Put it in one file (`src/mocks.ts`) so it's easy to rip out. Do not shape your
components around whatever the API happens to return later — shape them around
this document, and if the API disagrees, the API is wrong.
