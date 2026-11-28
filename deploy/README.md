# Public demo deployment

How the demo instance runs on one Linux server with Docker. It is the same stack as
`docker compose up` in the main README, with three differences:

- Only the web app has a port, on `127.0.0.1`. The API and Postgres stay inside the
  compose network.
- The login token secret, the public address and the demo password come from
  `deploy/demo.env`, which is not committed.
- The seeded accounts use `SEED_PASSWORD` instead of the public default.

Payments, the activation fee, the identity check and email are still simulated. The
simulated inbox at `/inbox` is public on purpose, so a visitor can finish email
verification. It holds only demo mail.

## Start or update

```
cp deploy/demo.env.example deploy/demo.env   # first time only, then fill it in
docker compose -p biletflow-demo -f docker-compose.yml -f deploy/docker-compose.demo.yml \
  --env-file deploy/demo.env up -d --build
```

The API migrates and seeds on every start. Seeding never duplicates rows and resets the
demo passwords to `SEED_PASSWORD`.

## HTTPS in front

Anything that proxies HTTPS to `127.0.0.1:WEB_PORT` works. Our instance uses Tailscale
Funnel:

```
sudo tailscale funnel --bg --https=10000 http://127.0.0.1:3201
```

## Fresh data

```
docker compose -p biletflow-demo -f docker-compose.yml -f deploy/docker-compose.demo.yml \
  --env-file deploy/demo.env down -v
```

then start it again. `-v` deletes the database volume.
