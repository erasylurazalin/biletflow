# BiletFlow mobile

The door scanner for event staff. A staff member logs in, sees the events they
are assigned to, scans ticket QR codes at the door, checks people in, undoes a
mistaken check-in and searches the attendee list.

## Run it

Start the API first, from the repository root:

```
npm ci
cp .env.example .env
docker compose up -d
npm run migrate
npm run seed
npm run dev          # API on http://localhost:3000
```

Then the app:

```
cd mobile
npm ci
npx expo start
```

Open it in Expo Go on a phone on the same Wi-Fi as the computer running the API
(scan the QR code from the `expo start` output). The app finds the API through
the dev server's LAN address and calls it on port 3000, so the dev machine must
accept connections on port 3000 from the local network. On Linux, allow it with
`sudo ufw allow 3000/tcp` if a firewall is running.

## Test logins (seeded)

- Door staff: `door@biletflow.kz` / `biletflow-dev`, assigned to the Astana Tech Meetup.
- Attendee with tickets: `attendee@biletflow.kz` / `biletflow-dev`. Their seeded
  ticket QR codes are shown in the web app (http://localhost:3001) under
  My tickets, so there is something to scan at the door.
