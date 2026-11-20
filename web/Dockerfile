# The web image for `docker compose up`. Local development uses `npm run dev` instead.

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# next.config.ts reads API_URL for its /api rewrite, and Next fixes rewrites at build
# time, so the address has to be known here as well as at runtime.
ARG API_URL=http://api:3000
ENV API_URL=$API_URL
RUN npm run build && npm prune --omit=dev && npm cache clean --force

FROM node:24-bookworm-slim
WORKDIR /app
ARG API_URL=http://api:3000
ENV API_URL=$API_URL NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/next.config.ts ./

USER node
EXPOSE 3001
CMD ["node_modules/.bin/next", "start", "-p", "3001"]
