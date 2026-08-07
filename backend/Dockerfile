# Multi-stage build → small runtime image with production deps only.
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY drizzle ./drizzle

# Non-root user for defense-in-depth.
RUN addgroup -S wysa && adduser -S wysa -G wysa
USER wysa

EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s \
  CMD wget -qO- http://localhost:${PORT:-4000}/health || exit 1

CMD ["sh", "-c", "node dist/db/migrate.js && node dist/index.js"]
