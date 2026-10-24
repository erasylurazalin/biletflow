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
