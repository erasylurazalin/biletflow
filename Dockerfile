# The API image for `docker compose up`. Local development does not use it: there the
# API runs on the host with `npm run dev`.

# Build stage: the dev dependencies (TypeScript) compile src/ into dist/.
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Runtime stage: production dependencies only, plus the files dist/ reads from disk.
FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# migrate.js and ticket-pdf.js find these relative to dist/, as they do relative to src/.
COPY migrations ./migrations
COPY assets ./assets

USER node
EXPOSE 3000

# Migrate, seed, then serve. Both scripts are safe to re-run, so every `docker compose up`
# brings the schema up to date and resets the demo rows (the seeded tickets go back to
# valid, the demo password is reset).
CMD ["sh", "-c", "node dist/db/migrate.js && node dist/db/seed.js && exec node dist/index.js"]
