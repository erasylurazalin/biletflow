# BiletFlow

Event ticketing for Kazakhstan. Organizers create events and issue QR-code tickets,
attendees buy or reserve them, and door staff scan the codes with a mobile app.

A student team project. The backend is Node, Express, TypeScript and Postgres with
hand-written SQL (no ORM), Zod for validation and Vitest for tests. The frontend is a
basic Next.js app in `web/`.

The API contract is in [docs/api.md](docs/api.md). How we work (branches, pull
requests, the lockfile, how an endpoint is laid out) is in
[CONTRIBUTING.md](CONTRIBUTING.md).

## Running it

Needs Node 24 (npm 11+) and Docker for the database.

```
npm ci
cp .env.example .env        # defaults match docker-compose.yml
docker compose up -d        # Postgres 16 on 127.0.0.1:5432
npm run migrate
npm run seed                # two users, two events, three ticket types
npm run dev                 # API on http://localhost:3000

curl http://localhost:3000/api/events
```

Frontend: `cd web && npm ci && npm run dev`, then http://localhost:3001.

`npm test` runs without a database. The tests that need a real Postgres (the
last-ticket race, paid checkout) run when `TEST_DATABASE_URL` points at a separate,
migrated database; see the top of `src/routes/orders.db.test.ts`. CI runs typecheck,
lint, format check and all tests on every pull request.

## Status

Built: auth, organizer profiles, ticket types, staff assignment, orders with free
registration and simulated paid checkout, paid sales activation, tickets with signed QR
payloads, and the event list and detail pages. All payments are simulated and labelled
as demonstration data.

Not built yet:

- Write endpoints for events
- Check-in
- The rest of the frontend (checkout, auth, my tickets) and the mobile scanner app
