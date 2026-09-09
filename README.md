# BiletFlow

Event ticketing for Kazakhstan. Organizers create events and issue QR-code tickets,
attendees buy or reserve them, and door staff scan the codes with a mobile app. This
repo is the backend: Node, Express, TypeScript and Postgres with plain SQL.

The API contract lives in [docs/api.md](docs/api.md). Read it before you write a
route. If your endpoint and the doc disagree, the doc wins until the group chat says
otherwise.

## Stack

Node + Express + TypeScript, Postgres via `pg` with hand-written SQL (no ORM), Zod for
input validation, Vitest for tests, Docker Compose for the database.

## Requirements

- **Node 24 LTS** and the npm that ships with it (npm 11 or newer)
- Docker and Docker Compose, for the database

Check what you have before anything else:

```
node -v    # v24.x.x
npm -v     # 11.x or newer
```

If Node is older, install 24 rather than working around it. `package.json` has an
`engines` field and `.npmrc` sets `engine-strict=true`, so npm refuses to install on
an older version instead of quietly producing a different lockfile.

With [nvm](https://github.com/nvm-sh/nvm) or [fnm](https://github.com/Schniz/fnm),
both of which read the `.nvmrc` in this repo:

```
nvm install    # or: fnm install
nvm use        # or: fnm use
```

## Setup

1. `git clone <repo-url> && cd biletflow`
2. `npm ci` (not `npm install`, see below)
3. `cp .env.example .env` (the defaults match docker-compose.yml, so you can leave them)
4. `docker compose up -d` starts Postgres 16 on port 5432
5. `npm run migrate` creates the tables
6. `npm run seed` inserts two users, two events and three ticket types
7. `npm run dev` starts the API on http://localhost:3000

Check it worked:

```
curl http://localhost:3000/api/events
```

Other scripts: `npm test` (Vitest, no database needed), `npm run build` and
`npm start` (compiled), `npm run lint`, `npm run format`.

Nothing here needs Docker except the database. If you already run Postgres locally,
skip step 4 and point `DATABASE_URL` at your own server.

## Dependencies and the lockfile

`package-lock.json` is committed and it is the source of truth for which versions we
all run. Two commands, and the difference matters:

- **`npm ci`** installs exactly what the lockfile says and never writes to it. This is
  the one you use: after cloning, after pulling, whenever `node_modules` looks wrong.
- **`npm install`** re-resolves the tree and rewrites `package-lock.json` as a side
  effect. Only run it when you are deliberately adding or upgrading a package.

Adding a dependency:

```
npm install <package>          # or npm install -D <package> for a dev tool
```

Then commit `package.json` and `package-lock.json` together, in the same pull request
as the code that needs the package, and say in the PR description why you added it.

A lockfile change with no `package.json` change next to it means somebody's npm
rewrote the file by accident. Do not commit that. Undo it with:

```
git checkout -- package-lock.json
npm ci
```

If that keeps happening to you, your Node or npm is not the pinned version. Run
`node -v` again.

## How to add an endpoint

Copy `src/routes/events.ts`. It has the comment block explaining the layering, and
every endpoint in the project is meant to look like it:

1. A Zod schema for the params, query or body, parsed at the top of the handler.
2. SQL written in the route file with `$1` placeholders. No ORM, no repository layer,
   no service layer. Never paste user input into a query string.
3. Map the rows into the exact JSON from `docs/api.md`. Do not return `result.rows`
   directly.
4. Throw `AppError` from `src/lib/errors.ts` on failure. Do not build error responses
   by hand; `src/middleware/error-handler.ts` does that for everyone.

Then mount the router in `src/app.ts` (one line) and write a test next to the route,
modelled on `src/routes/events.test.ts`.

New tables go in a new numbered file under `migrations/`, for example
`002_promo_codes.sql`. Do not edit a migration that has already run, because everyone
else's database will skip it.

## Database notes

- Money is an INTEGER in tiyn. 1 KZT = 100 tiyn, so `500000` is 5000 tenge. No floats
  anywhere near a price.
- Timestamps are `timestamptz`.
- Primary keys are UUIDs from `gen_random_uuid()`.
- Statuses are TEXT with a CHECK constraint, so adding a new status is one migration.
- `ticket_types.quantity_available` is not a column. It is computed from the orders
  table, see the query in `src/routes/events.ts`.

## Working together

Branch names:

- `feat/orders-endpoint` for new features
- `fix/event-list-limit` for bug fixes
- `docs/api-contract-orders` for documentation

Everything goes through a pull request. No pushing to `main`, including small fixes,
including your own branch merged locally. Open the PR, get one teammate to read it,
then merge. `npm test` and `npm run lint` have to pass first.

Keep pull requests small enough that somebody can read them in ten minutes.

Before you open one: `npm ci && npm test && npm run lint`, and check `git diff` for a
`package-lock.json` you did not mean to change.

## Not built yet
These are four tasks:

- Auth: register, login, password hashing, JWT. `src/middleware/auth.ts` is a stub that
  parses the header and throws.
- Write endpoints for events and ticket types.
- Orders, tickets, QR payloads, payments, check-in.
- The frontend and the mobile scanner app.
