# PostgreSQL client major. pg_dump can dump any server up to its own version, and a dump written by
# pg_dump N needs pg_restore N or newer to read it, so pick the tag that matches your server:
#   ghcr.io/siddhujz/dumpling-backup:16 | :17 | :18 (latest)
ARG PG_MAJOR=18

# ---- build stage -----------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime stage ---------------------------------------------------------
FROM node:22-bookworm-slim
ARG PG_MAJOR
WORKDIR /app
ENV NODE_ENV=production

# pg_dump/pg_restore from PGDG at the requested major; mysqldump is MariaDB's (Debian's default),
# whose flags the tool adapts to at runtime.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl gnupg lsb-release openssl \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update && apt-get install -y --no-install-recommends postgresql-client-${PG_MAJOR} mariadb-client \
 && apt-get purge -y gnupg lsb-release curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/dist ./dist
USER node
ENV STATUS_FILE=/tmp/dumpling-backup/status.json
# Absolute paths: GitHub Actions overrides WORKDIR with the checked-out workspace when it runs the image.
HEALTHCHECK --interval=5m --timeout=10s --start-period=2m CMD ["node", "/app/dist/healthcheck.js"]
CMD ["node", "/app/dist/index.js"]
