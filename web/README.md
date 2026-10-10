# BiletFlow web

Next.js frontend. The home page and the event page read published events from the API (`GET /api/events` and `GET /api/events/:id`), including ticket types and prices on the detail page.

Start the API first, from the repo root: `docker compose up -d`, `npm run migrate`, `npm run seed`, `npm run dev`.

```
cd web
npm ci
npm run dev
```

Opens on http://localhost:3001 so it does not fight the API on :3000. The server looks for the API at `http://127.0.0.1:3000`. Set `API_URL` if yours is somewhere else. That variable is read on the server only.
