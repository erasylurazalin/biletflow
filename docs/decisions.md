# Decisions

Where the SRS (version 0.3) is silent or ambiguous, this file records how we read it.
Each entry names the SRS sections it rests on and the reading we rejected. The SRS
itself is not ours to change: if an entry turns out to be wrong, we ask the
instructor, then update the entry.

New entries go at the bottom, numbered.

---

## 1. Becoming an organizer means creating an organizer profile

**Decision.** Everyone registers as a regular user. A user becomes an organizer by
creating an organizer profile (`POST /api/me/organizer-profile`), which is
self-service and needs no approval. Creating the profile switches the user's role to
`organizer`. Verification is a separate, later step that gates paid ticket sales
only, never creating events.

**SRS basis.**

- 1.3: an Organizer is "a user who creates and manages an event", so an organizer is
  a kind of user, not a separate account type.
- 4.1: users register with an email, "organizers shall have a profile containing
  contact and payout information", and the system supports role-based permissions.
- 8: organizer profiles are a required MVP feature.
- 3.1 and 3.2: free events need nothing from the organizer. Identity and payout
  verification are listed as steps for activating paid sales.

**Rejected.** A separate organizer sign-up, or a platform admin approving every new
organizer. Neither is in the SRS, and approval would block free events, which 3.1
says organizers can create without charge.

**Where.** `migrations/003_organizer_profiles.sql`, `src/routes/me.ts`, the
"Organizer profile" section of `docs/api.md`.

---

## 2. Event admin rights come from staff assignment, not from the user's role

**Decision.** An organizer puts people on the door of a specific event. Being
assigned to that event is what lets somebody scan its tickets. Any registered user
can be assigned, the organizer included, and assigning does not change their role.
The `event_admin` value of `users.role` opens no event by itself.

**SRS basis.**

- 1.3: an Event Admin is "an organizer-authorized user", authorized by the organizer
  and not by the platform.
- 2.3: organizers "assign check-in staff", and Event Admins "select assigned events".
- 4.8: the app lets them "view only assigned events".
- UC4: the precondition is that the Event Admin is "assigned to the event".
- 6: Staff Assignment is its own data entity.

**Rejected.** Letting the `event_admin` role scan. A role says nothing about which
events, so every event admin would see every event, against 4.8. Changing the role
on assignment was rejected too: one person can be on the door of one event and an
attendee at another, and an organizer may want to scan at their own door.

**Where.** `migrations/002_event_staff.sql`, `src/routes/staff.ts`, the "Staff
assignments" and "Check-in" sections of `docs/api.md`.

---

## 3. Paid sales activation is a five-item checklist, simulated where it touches money

**Decision.** Paid ticket types on an event can be bought only after the organizer
activates paid sales for that event. Activation checks five things: the event has a
paid ticket type, the organizer passed the identity check, the organizer profile has a
payout account, the activation fee is paid, and the paid-event terms are accepted.
Identity and payout belong to the organizer and count for every event. The fee and
the terms are per event. The identity check, the fee and every ticket payment are
simulated: nothing is checked against real documents and no money moves. The fee is
5,000 KZT.

Every payment is stored with `is_demonstration = true`, the database refuses a
simulated payment marked as real, and the API returns the flag on every payment.

**SRS basis.**

- 3.2: the five steps, and "identity checks, activation-fee payment, ticket payment,
  and organizer payouts may be implemented with a provider sandbox or clearly labelled
  simulation".
- 3.3: the fee is "one-time per event, charged in KZT; amount to be determined". 5,000
  KZT is our pick until the instructor or a platform admin setting says otherwise.
- 4.5: paid tickets are not purchasable before activation, the organizer sees a
  checklist, the fee payment is recorded, and activation applies only to the selected
  event.
- 4.6 and 11: demonstration payments are never presented as real transactions, and an
  organizer can "complete the simulated or sandboxed paid-sales activation".
- UC2: the flow is verification, payout account, fee, terms.

**Rejected.** Leaving the identity step out: 3.2 lists it, so the checklist would not
match the SRS. Repeating identity and payout for every event: they describe the
organizer, not the event, and 4.1 puts payout information on the organizer profile. A
real payment sandbox: 3.2 allows a labelled simulation, and a sandbox account is one
more thing that can break on demo day.

**Where.** `migrations/004_paid_sales.sql`, `src/routes/paid-sales.ts`,
`src/lib/payments.ts`, the "Paid sales activation" and "Orders" sections of
`docs/api.md`.

---

## 4. A pending order holds its seats for 15 minutes

**Decision.** Placing an order holds its seats for 15 minutes, for free and paid
orders alike. After that the order holds nothing, reads as `cancelled`, and cannot be
paid, so it never produces tickets.

**SRS basis.**

- 4.6: "ticket inventory shall be temporarily reserved during checkout", and "failed or
  abandoned transactions shall not create valid tickets". No duration is given.

**Rejected.** 10 minutes, our first default: tight for somebody filling in attendee
details on a phone. Separate times for free and paid orders: a free order is paid at
once anyway, so a second number buys nothing.

**Where.** `HOLD_MINUTES` in `src/routes/orders.ts`, "Creating an order" in
`docs/api.md`.

---

## 5. Attendees pay a 3% processing charge

**Decision.** The attendee pays a processing charge, shown as a separate
`processing_fee` line in the order total. It is 3% of the ticket price after discount,
rounded to the nearest tiyn, and 0 for free tickets. The total, including this charge,
is the amount of the simulated payment.

**SRS basis.**

- 4.6 asks the system to calculate ticket totals and processing charges.
- 12 leaves open whether the attendee or the organizer pays the charge.

**Rejected.** Adding the charge to the organizer's payout instead: attendees need to
see the full checkout cost before the simulated payment. Folding it into ticket prices
was rejected too, because SRS 4.6 calls for processing charges to be calculated and
shown.

**Where.** `PROCESSING_FEE_PERCENT` in `src/routes/orders.ts`, the "Orders" section of
`docs/api.md`, and `migrations/007_checkout_details.sql`.

---

## 6. The backend is Node.js, Express and TypeScript on PostgreSQL

**Decision.** The backend uses Node.js, Express 5, TypeScript and PostgreSQL. The web
app uses Next.js and the mobile app uses React Native with Expo, so one language covers
backend, web and mobile. API types read the same everywhere.

Express 5 is small and has no framework conventions to learn first. Zod validates every
request body. Vitest with supertest runs the API tests without a real server.

Orders, tickets, inventory and check-ins are relational and need transactions and
constraints. Postgres provides row locks with `SELECT ... FOR UPDATE`, conditional
updates so two scans of one ticket cannot both succeed, unique indexes for duplicate
emails, and check constraints. The backend uses plain SQL with numbered migrations in
`migrations/`, with no ORM.

Deployment needs one Node process and one Postgres database. Postgres runs in Docker
through `docker-compose.yml`.

**SRS basis.**

- 9: TypeScript is recommended across web and mobile and may be shared with a Node
  backend. The section asks for a rationale covering team familiarity, development
  speed, data model and deployment complexity.
- 8: the demo deployment is Docker-based.

**Rejected.** MongoDB, which SRS 9 allows, because the inventory and check-in rules
rely on transactions and constraints across several tables. An ORM, because the team
would learn its API instead of SQL. A second backend language, because SRS 9 rules out
multiple backend implementations.

**Where.** `src/`, `migrations/`, `docker-compose.yml`, `CONTRIBUTING.md`.

---

## 7. Encryption in transit and at rest, read for a local demo

**Decision.** Passwords are hashed with bcrypt. Email verification and password reset
tokens are stored only as sha256 hashes. Payments are simulated and take no card
details, so no card data exists anywhere.

The demo runs on localhost, where HTTPS adds nothing. In any real deployment, TLS
terminates in front of the API at a reverse proxy or the host, and disk encryption is
the host's job. The application does not implement either itself.

**SRS basis.**

- 7: sensitive information shall be encrypted in transit and at rest, passwords shall
  use secure password hashing, and payment-card data shall not be stored directly by
  the platform.
- 3.2 and 4.6: payments may be simulated.

**Rejected.** Building TLS or field-level encryption into the app for a demo that never
leaves one machine.

**Where.** `src/routes/auth.ts`, `src/lib/email-tokens.ts`, `src/lib/payments.ts`.

---

## 8. Accessibility: WCAG 2.1 AA is a target, not a certified result

**Decision.** Pages use semantic HTML, including headings, `nav`, `main`, and buttons
and links for actions. Every text field has a visible label, and the ticket quantity
selects have an `aria-label`. Errors are shown as text,
with `role="alert"` on the auth form. Ticket statuses are written as words, not only
shown as colour.

No formal WCAG audit has been done. WCAG 2.1 AA is a target, not a certified result.

**SRS basis.**

- 7: event pages should meet WCAG 2.1 AA. "Should" is read as a goal.

**Rejected.** Claiming AA compliance without an audit.

**Where.** `web/src/`.

---

## 9. No Figma file: the design lives in the code

**Decision.** The team designed directly in the web app with Tailwind CSS. There is no
Figma file. The suggested technology stack is read as suggestions.

**SRS basis.**

- 9: Figma and Tailwind CSS are suggested tools. The stack is "recommended for
  consistency".

**Rejected.** Drawing a Figma file after the fact.

**Where.** `web/src/`.

---

## 10. Refunds are full, started by the organizer, and blocked once a ticket is used

**Decision.** The organizer of the event can refund a paid order in full (simulated)
or cancel a free registration. There are no partial refunds and no way for an
attendee to start a refund. Only paid orders qualify. If any ticket of the order was
already scanned at the door, the whole action is refused. A refunded or cancelled
order releases its seats through the ordinary availability computation, and a refund
records one row in a `refunds` table, an audit entry and a buyer email, all in the
transaction that changes the order. The event may carry a free-text `refund_policy`
of at most 2000 characters, shown to attendees; it is information only and nothing
enforces it.

**SRS basis.**

- 4.9: the organizer can cancel a registration and process a refund; refunds update
  the order, invalidate the tickets and return the seats to inventory.
- UC5: the organizer selects the order and confirms the refund; the system updates
  the order, invalidates the ticket and restores inventory.
- 13.4: "advanced refund and dispute workflows" are listed as non-functional future
  work and excluded from the MVP by 8. Full refunds only is our reading of that
  exclusion: partial refunds, disputes and attendee-initiated refunds all belong to
  the advanced workflows.
- 3.2 and 4.6: money is simulated, so a refund is a demonstration refund and is
  labelled like every other demonstration payment.

**Rejected.** Attendee-initiated refunds with organizer approval: UC5 puts the action
in the organizer's hands, and an approval queue is an advanced workflow. Partial
refunds per ticket: 13.4 excludes them from the MVP. Blocking refunds on cancelled
events: an organizer who calls off an event is exactly the person who must refund its
paid orders afterwards. Enforcing the refund policy in code: the SRS says nothing
about what a policy must contain, so it is left as free text.

**Where.** `migrations/008_refunds.sql`, `src/routes/organizer-orders.ts`,
`src/lib/refunds.ts`, the "Refunds and cancellations (organizer)" section of
`docs/api.md`.

---

## 11. Promo codes: one per order, the limit counted like seats, and fees not discounted

**Decision.** A promotional campaign belongs to one event and carries a percent or
fixed-KZT discount, an optional validity window, an optional redemption limit and an
optional list of covered ticket types. Each campaign has a promo code, typed by the
buyer, and a campaign link with an opaque token, whose QR code is generated on the
server and opens no door: check-in refuses anything that is not a signed ticket
payload.

An order carries at most one promo code. A redemption counts while its order is
`paid`, or `pending` and not expired: the same rule as held seats. An abandoned
checkout therefore frees its redemption by itself, and a refund or cancellation frees
it too, without anyone sweeping rows. The limit is enforced under a lock on the
campaign row inside the order transaction, so it holds when many people check out at
once.

The discount covers only the items whose ticket type the campaign covers. A percent
discount is rounded to the tiyn; a fixed discount is capped at the covered subtotal
and applies once per order. The 3% processing charge is computed from the price after
the discount and is never discounted itself. In the campaign report, `orders`,
`tickets sold` and revenue count paid orders only; processing fees are not revenue
for the organizer and are left out.

**SRS basis.**

- 4.14: promotional campaigns with percentage or fixed-KZT discounts, validity dates,
  maximum redemptions and applicable ticket types, plus campaign QR codes that are
  not admission tickets.
- UC10: the buyer enters a promo code at checkout; the system validates it and applies
  the discount.
- 11, success criteria 7 and 8: a campaign link shows the discount applied, and the
  scanner can tell a campaign QR code from an admission ticket.
- 4.6: the system calculates totals and processing charges.

**Rejected.** Stacking several codes on one order: the SRS speaks of "a promo code",
and one-per-order keeps the discount explainable at checkout. Counting abandoned
orders against the limit: a checkout that was never paid is not a redemption, and
seats it held are released too. Discounting the processing charge: the charge exists
to cover the platform's cost (decision 5), so it is taken on the discounted price,
which is also what keeps a 100% campaign free instead of paying the buyer's fee for
them.

**Where.** `migrations/009_promo_codes.sql`, `src/routes/promo-campaigns.ts`,
`src/routes/orders.ts`, the "Promo codes and campaign QR codes (organizer)" and
"Orders" sections of `docs/api.md`.

---

## 12. Analytics are computed on read, and revenue means the money the organizer keeps

**Decision.** The analytics endpoint computes every number from orders, order items,
tickets, refunds, redemptions and check-ins on each request and stores none of them.
Capacity is the sum of the ticket types' `quantity_total`, hidden types included.
Sold counts the tickets of paid orders only, so a refund, a cancellation or an
abandoned checkout takes its tickets back out; seats still held by pending orders are
reported next to it and are not sales. Gross is the sum of the subtotals of every
order that reached paid, refunded ones included, discounts are theirs, refunds are
the discounted subtotal of the refunded ones, and net is gross minus discounts minus
refunds. The 3% processing charge is never organizer revenue, so it sits outside all
four figures, which also means a refund lowers net by less than the buyer is
refunded. Attendance counts tickets in status `valid` or `checked_in`: absent is
`valid`, and refunded and cancelled tickets are neither. Date filters and day buckets
use Kazakhstan time (`Asia/Almaty`, UTC+5, no daylight saving). The campaign block
repeats the campaign report numbers unchanged, so the date range does not narrow it.

**SRS basis.**

- 4.15: capacity, sold, remaining and percentage sold; gross sales, discounts,
  refunds and net demonstration revenue in KZT; sales over time from order
  timestamps; comparison by ticket type; campaign redemptions, attributed tickets and
  revenue; checked-in attendees, absent holders and the check-in percentage; filters
  by event, date range and ticket type; and all of it calculated from BiletFlow
  records.
- UC11: the organizer opens the dashboard, selects a date range or a ticket type, and
  reviews sales, revenue, campaign performance and attendance.
- Section 11, criterion 10: basic sales, capacity, campaign and attendance analytics
  without adding fields to the attendee checkout.
- 3.2 and 4.6: money is simulated, so this is demonstration revenue and is labelled
  like every other simulated amount.
- Decisions 5 and 11: the processing charge covers the platform's cost and is not
  organizer revenue; the campaign report already leaves it out.

**Rejected.** Stored counters or a nightly rollup: a counter drifts the first time a
refund, a cancellation or an undone check-in arrives, and these volumes never need
one. Leaving refunded orders out of gross instead of subtracting them: the organizer
needs to see both what sold and what came back. Splitting an order's discount across
its ticket types: the discount is recorded per order, and an invented split would
produce per-type numbers nobody could reconcile with the order. Counting pending
orders as sold: an unpaid checkout is not a sale. Filling days without sales with
zeros: an empty day is visible by its missing date, and zeros would make a long quiet
period look like activity. Using UTC for day buckets and plain date filters: the
events and the team are in Kazakhstan, and a sale at 02:00 local would otherwise be
counted on the previous day.

**Where.** `src/routes/analytics.ts`, `src/lib/campaigns.ts`,
`web/src/app/organizer/events/[id]/analytics/page.tsx`, the "Analytics (organizer)"
section of `docs/api.md`.

---

## 13. The printable ticket is a PDF rendered from the ticket record, never a stored file

**Decision.** `GET /api/tickets/:id/pdf` renders a one-page A4 PDF from the canonical
ticket record on every request and stores no file: the event title, date and time in
Kazakhstan time, venue name and address, ticket type, attendee name, ticket code, the
ticket's status, and the QR code of its `qr_payload`. Every status prints. The payload
is the same one the app shows, so a printed copy is the same admission and the scanner,
not the paper, decides validity. The page carries no price, no payment data, no email
and no seat, because BiletFlow assigns no seats. The QR is black on white, at least
60 mm square, with a quiet zone and error correction level Q, so a grayscale print on
A4 decodes. The code sits a fixed distance above the footer with the text filling the
space above it, so text that cannot fit is shortened with a trailing ellipsis, while the
ticket code, the status and the QR code are never shortened. Text uses an embedded
DejaVu Sans, because standard PDF fonts cannot encode Kazakh and Russian names.

**SRS basis.** 4.11 and UC7 (the contents list, no payment-card details, one identifier
for digital and printed copies); section 8 (legible text and scannable QR on A4, in
colour or grayscale, and the server-generated PDF from the canonical record); section
11, criterion 4.

**Rejected.** Storing or caching generated files: the record is canonical and a stale
file would print a status that is no longer true. Printing only valid tickets: an
attendee who prints before a refund keeps paper that looks usable, and a status on the
page is more honest than a missing document. Dropping the QR from cancelled and
refunded tickets: the scanner has to answer "cancelled" or "refunded" for printed paper,
which needs the payload. Rendering in the browser: print CSS differs per browser and the
SRS asks for a server-side PDF. Standard PDF fonts with transliteration: mangling a
Kazakh name on an admission document is worse than shipping a font.

**Where.** `src/lib/ticket-pdf.ts`, `src/routes/tickets.ts`, `assets/fonts/`,
`web/src/api.ts`, `web/src/app/tickets/page.tsx`, the "Printable ticket (PDF)" part of
`docs/api.md`.

---

## 14. Support cases are visible only to the opener and the case's responders

**Decision.** A case is either `event` or `platform`. An `event` case needs an event
the caller holds a paid order for. Its optional order and ticket context must belong
to the caller and to that event, and mismatches read as 404 like every other
attendee resource. They are context only: the paid order that grants access may be a
different order. A `platform` case is open only to a user whose stored role is
`organizer` and who has an organizer profile, and it carries no event, order or
ticket context.

The participants are the opener plus the responders. For an `event` case the
responders are the event's organizer and every `event_staff` member of that event;
for a `platform` case every user with role `platform_admin`. Anyone else gets 404
`SUPPORT_CASE_NOT_FOUND` on every case endpoint, platform admins on foreign event
cases included, so case ids cannot be probed. A participant who cannot respond (the
opener) gets 403 on `PATCH`. The list's `role` is `opener` for the user who opened
the case even if that user is also a responder, because the case is still theirs;
authorization to respond is decided by the relationship, not by the label.

Statuses move freely among `open`, `in_progress`, `waiting_for_customer` and
`resolved`, only a responder changes them, and nothing changes them automatically.
`assigned_to` is nullable, must name a responder of the same case, and `null`
unassigns. A case starts `open`, unassigned, with its first message in the same
transaction. A resolved case still accepts replies.

The case object carries the event title flat as `event_title` and `last_message_at`
for list ordering. The detail response also carries `responders`, so the web page can
offer an assignee picker without another endpoint. List order is newest activity
first. Email follows the rule in the task: a responder reply or status change mails
the opener, an opener reply mails the assignee, else the event organizer for an event
case, else nobody. A user is never mailed about their own message. Only opening, a
status change and an assignment change write audit entries; a message is not an
organizer or administrator action.

The web thread polls `GET /api/support/cases/:id` every 10 seconds. There are no
sockets, as SRS 9 requires.

**SRS basis.** 4.13 (context from an event, order or ticket, categories, asynchronous
thread, assignment and the four statuses, notifications, history and access control);
UC9 (an attendee opens from an event, order or ticket and the organizer replies);
section 9 (REST with periodic refresh, no real-time sockets); section 11, success
criterion 6; SRS 4.10 lists new support messages, assignments and status changes as
notifications.

**Rejected.** Letting an organizer open an event case for an event they have no paid
order for: the decided rule grants event access through a paid order, and staff
already have the organizer dashboard for their own events. Letting platform admins
see every event case: responders for an event case are defined by the event, and a
platform admin with no relationship has no business reading its thread. Automatically
moving a case to `waiting_for_customer` after a staff reply: the decided rule says no
automatic status changes. A second endpoint for the responder list: one small array
on the detail response is enough for the assignee picker. Sending a case confirmation
email on creation: the task lists only replies and status changes, and in-app history
is the confirmation.

**Where.** `migrations/011_support_cases.sql`, `src/routes/support.ts`,
`src/lib/audit.ts`, `src/lib/errors.ts`, the "Support cases" section of
`docs/api.md`, `web/src/app/support/`, `web/src/api.ts`, the dictionaries and the
support entry links on the ticket, order, event, header and organizer profile pages.

## 15. Administration: immediate login suspension, report review, one platform fee, and CSV exports

**Decision.** Platform administration adds four pieces, all reached only by
`platform_admin`:

- **Users.** `users.suspended_at` and `users.suspended_by` are a flag and an actor, with
  a CHECK that keeps them together. A suspended user cannot log in: login answers
  `403 ACCOUNT_SUSPENDED` after the password check. An admin cannot suspend themselves
  or another platform administrator (409), and an already suspended account is 409.
  Unsuspending clears both fields and writes `user.unsuspended`. Already-issued JWTs
  are not checked against the database, so an existing session ends when its token
  expires (7 days), while login is refused immediately. `requireAuth` stays a pure JWT
  check on purpose: changing it would make every unit test's fake pool need a user
  lookup, and the task rules forbid that change.
- **Events and reports.** Event search returns every status with organizer name and
  email, suspension state and the number of open reports. Any logged-in user can report
  a published, unsuspended event with a reason of 1 to 1000 characters after trimming.
  One open report per user per event is a partial unique index, so a duplicate is 409;
  after a report is closed the same person may report again. The admin queue defaults
  to open reports, oldest first. Dismissing one report writes
  `event_report.dismissed`. Suspending through a report reuses the existing event
  suspension function (same row lock, update and `event.suspended` audit) and then marks
  every open report on that event `actioned`. If the event is already suspended, the
  reports are still actioned but no second suspension entry is written.
- **Activation fee.** `platform_settings` holds one row, starting at `500000` tiyn
  (5,000 KZT) and refusing a negative number. `GET` and `PATCH /api/admin/settings`
  expose it, and `PATCH` writes `platform_settings.updated`. Paid sales reads the
  current fee inside its existing query, so a change applies to the next fee payment.
  An already-paid fee keeps the amount stored on its `payments` row and the paid-sales
  response shows the current amount next to that payment.
- **Orders and exports.** Order search matches order id or buyer email and includes
  every status, the payment, the refund, and failed payment attempts counted from
  `order.payment_failed` audit entries (a failed payment writes no `payments` row).
  Orders and refunds export as UTF-8 CSV with a header row. Amounts are tenge with two
  decimals, timestamps are ISO 8601 UTC, and values containing a comma, quote or newline
  are quoted with embedded quotes doubled. The optional `q` and `status` filters narrow
  an export to the same slice as the list.

**SRS basis.** 2.1 (an administrative web portal), 4.12 (search users, events, orders
and payments; suspend users and events; review reported events; monitor refunds and
payment failures; configure activation fees and platform settings; export operational
reports), 4.5 (the activation fee and the platform admin's moderation role), 3.3 (the
fee amount is left to us), 7 and 4.9 (administrator actions are auditable), 4.6 (every
payment and refund is simulated and labelled).

**Rejected.** Checking `users.suspended_at` inside `requireAuth`: it would add a query
to every authenticated request and force a fake user row into every existing unit test
that uses a fake pool. Deleting a suspended account: SRS 4.12 says suspend, not delete,
and orders and audit rows must keep pointing at the account. Letting a platform admin
suspend another platform admin: it would let one admin lock out the rest, and there is
no separate recovery path. Treating the fee as a per-event activation record for this
task: the SRS asks for platform settings, already-paid amounts are financial records and
must not move, and per-event paid-sales suspension or activation records were outside
the tested scope of issue #63. Returning all orders through the CSV endpoint with no
filter: a large export is hard to test and hard to read, and the same list filters cost
nothing.

**Where.** `migrations/012_admin.sql`, `src/routes/admin.ts`, `src/routes/auth.ts`,
`src/routes/paid-sales.ts`, `src/lib/errors.ts`, `src/lib/audit.ts`, the "Admin: users",
"Admin: searching events", "Reported events", "Admin: platform settings" and
"Admin: orders and CSV exports" sections of `docs/api.md`, `web/src/app/admin/`,
`web/src/report-event-button.tsx`, `web/src/header.tsx`, `web/src/api.ts` and the three
dictionaries in `web/src/i18n/dictionaries/`.

## 16. Event history reads the audit log, and duplication copies configuration by whole weeks

**Decision.** Every event has a computed `phase` on `GET /api/me/events`: `draft` or
`cancelled` from `status`, otherwise `upcoming` when the start is in the future,
`completed` when the end has passed, and `active` in between. `?phase=` filters on that
same expression. The event timeline is
`GET /api/events/:id/timeline`, newest first, over the existing append-only
`audit_log`. It is readable by the event's organizer, a user in that event's
`event_staff`, and a `platform_admin`; anyone else and any unknown id gets
`404 EVENT_NOT_FOUND`. Every status answers, including cancelled and suspended events.
A plain `from` or `to` date covers that whole day in Kazakhstan time (`Asia/Almaty`),
and both ends are inclusive. `action` is restricted to `AUDIT_ACTIONS`, and the response
also carries the distinct actions that exist for the event so the web filter offers
only those. Creating an event now writes `event.created` in the same transaction, which
is how the timeline starts; the seed already wrote this entry, and the create endpoint
was the one gap.

Duplication is `POST /api/events/:id/duplicate`. Only the organizer may call it, and
others and unknown ids get the same 404 as the timeline. The copy is always a `draft`
and never suspended. It copies the event's descriptive fields, `refund_policy`, start
and end times, and every ticket type configuration column. When the source start is not
in the future, the start and end move forward by whole weeks until it is: the weekday
and local time of day stay the same because the shift is an exact multiple of seven
days. Ticket type sales windows move by the same number of weeks, otherwise a past
event would be copied with its sales already closed. Orders, order items, tickets,
payments, refunds, check-ins, promo campaigns and redemptions, staff assignments,
paid-sales activation, suspension and support cases are not copied. The new event gets
`event.created` and `event.duplicated`; the second description names the source id.

**SRS basis.** 4.16 classifies events as Upcoming, Active, Completed or Cancelled, asks
for a chronological timeline with timestamp, actor, action, entity and description,
filters by date range and activity type, limits staff to events they manage, and allows
platform admins to read it for support. UC12 and success criterion 11 say a past event
can be duplicated without copying historical transactions. Section 7 requires event
history to use the same event-level authorization as the records it describes.

**Rejected.** A stored `phase` column: it would be wrong the moment the clock passes a
start or end. A stored event timeline separate from `audit_log`: two histories would
drift. Returning 403 to an outsider or to an unknown id: a 404 does not confirm that an
event exists. Dropping the actor when the account is gone: the entry keeps the text it
was written with, and only the actor object becomes null. Shifting a past event to
"tomorrow" instead of by whole weeks: that would silently change the weekday and the
time of day. Copying ticket type sales windows unchanged: the draft would look reusable
but could never sell a ticket. Copying promo campaigns so the same code works again:
codes, redemptions and limits are history, not configuration.

**Where.** `src/routes/me.ts`, `src/routes/event-history.ts`, `src/routes/events.ts`,
`src/lib/audit.ts`, `web/src/app/organizer/events/page.tsx`,
`web/src/app/organizer/events/[id]/page.tsx`,
`web/src/app/organizer/events/[id]/timeline/page.tsx`, `web/src/api.ts`,
`web/src/i18n/dictionaries/`, the "My events" and "Event history and duplication"
sections of `docs/api.md`.

## 17. Event search covers four text fields, filters by Kazakhstan local days, and counts every match

**Decision.** `GET /api/events` keeps its public rule (published and not suspended) and
adds three optional filters, combined with AND. `q` is trimmed to 1 to 100 characters
and is a case-insensitive substring match on the title, description, venue name or venue
address, so a city name in the address is enough to find the event. `%`, `_` and `\` in
`q` are escaped and match themselves. `from` and `to` are plain `YYYY-MM-DD` dates and
both ends are inclusive. They compare the event's `starts_at` against local midnights in
`Asia/Almaty`, so a start at 23:30 on the `to` day is inside the range and a start just
after midnight the next day is outside it. An impossible date, or a `from` later than
`to`, is `400 VALIDATION_ERROR`. `free=true` keeps events that have at least one visible
ticket type priced `0`; a hidden free type does not count, and `free=false` applies no
filter. Paging, ascending start order and the limit of 100 stay as they were. The list
envelope gains `total`, the number of events matching the same filters with no paging,
computed by a second query with the same fixed WHERE clause so an offset past the last
match still reports the real total. The local-midnight helper moved to
`src/lib/local-date.ts` and event history uses the same copy. The home page posts a plain
GET form to `/?q=&from=&to=&free=true`, so the URL reproduces the search without
JavaScript, and shows the `total` plus an empty state with a Clear link.

**SRS basis.** The SRS says "Attendees will be able to discover events" and "Can browse
events". A title-only match does not let somebody find events by city, and a date or
price filter is how an attendee narrows a list they can browse.

**Rejected.** Searching only the title, which misses the common "what is on in Almaty"
query. Passing `q` straight into `ILIKE` without escaping, because then `%` or `_` would
silently match everything. Filtering dates in UTC or in the server's zone: an event at
23:30 in Kazakhstan would fall on the wrong day. Treating any zero-price type as free,
including a hidden one, because the public page never shows that ticket. A separate
count endpoint, which would be a second contract to keep in step. Returning all matches
and counting them in the web app, which breaks once the list is paged.

**Where.** `src/routes/events.ts`, `src/lib/local-date.ts`,
`src/routes/event-history.ts`, `src/routes/events.test.ts`,
`src/routes/events-search.db.test.ts`, `web/src/app/page.tsx`, `web/src/api.ts`,
`web/src/i18n/dictionaries/`, the "Searching and filtering the public list" section of
`docs/api.md`.
