# dumpling-backup

Scheduled `pg_dump` / `mysqldump` backups, streamed straight into your own S3-compatible bucket and
**checked for restorability on every run**. One container, no disk, no state, no UI.

```
2026-10-18T02:00:00.412Z Running pg_dump for postgres db.internal:5432/app -> s3://db-backups/app/2026-10-18T02-00-00Z.dump
2026-10-18T02:00:04.118Z Uploaded 48211734 bytes in 3706 ms
2026-10-18T02:00:04.301Z Verified: 142 tables with data, 96 indexes, 611 entries
2026-10-18T02:00:04.302Z OK app: 48211734 bytes, verified (142 tables with data, 96 indexes, 611 entries), 3890 ms
```

Why another backup container: the ones most people run (`schickling/postgres-backup-s3`,
`eeshugerman/postgres-backup-s3`) are unmaintained, and none of them tells you whether the file
that landed in the bucket would actually restore. This one feeds the dump through `pg_restore --list`
as it streams (or checks `mysqldump`'s completion trailer) and marks the run failed, with exit code 1
and a webhook call, if the archive is unreadable. A dump tool that dies is caught separately: its
partial object is deleted.

- **PostgreSQL** (custom format, `pg_restore`-ready) and **MySQL / MariaDB** (gzipped SQL)
- **Any S3-compatible bucket**: Amazon S3, Cloudflare R2, Backblaze B2, Wasabi, DigitalOcean Spaces, Hetzner Object Storage, MinIO
- **Streams**: the dump never touches local disk; a 50 GB database needs no 50 GB volume
- **Verified**: `pg_restore --list` on the stream for Postgres, trailer check for MySQL; an unreadable archive is a failed run (the file is kept for inspection), never a green tick
- **Safe by construction**: a dump tool that exits non-zero fails the upload; stalls are killed; partial objects are removed; retention only ever deletes files this tool wrote
- **Retention** by count and/or age; **encryption** with an OpenSSL-compatible passphrase; **alerts** to Slack, Discord or any webhook; **healthcheck** ping (healthchecks.io style) and a Docker `HEALTHCHECK`
- Runs as a long-lived container with its own cron, or as a one-shot (`SCHEDULE=once`) for Render cron jobs, Railway cron schedules and GitHub Actions

## Quick start

```bash
docker run --rm \
  -e DATABASE_URL='postgresql://backup:PASSWORD@db.example.com:5432/app?sslmode=require' \
  -e S3_ENDPOINT='https://<accountid>.r2.cloudflarestorage.com' \
  -e S3_BUCKET='db-backups' \
  -e S3_ACCESS_KEY_ID='...' -e S3_SECRET_ACCESS_KEY='...' \
  -e SCHEDULE=once \
  ghcr.io/siddhujz/dumpling-backup:18
```

That runs one backup, prints what it verified, and exits 0 on success or 1 on failure. Drop
`SCHEDULE=once` (or set a cron expression) and the container stays up and runs on schedule, with a
backup at start so a misconfiguration shows up in seconds rather than at 02:00.

**Pick the image tag that matches your PostgreSQL major version**: `:16`, `:17` or `:18` (`latest` is
18). `pg_dump` can dump any server up to its own version, and a dump written by `pg_dump` 18 needs
`pg_restore` 18 or newer to read it; using the matching tag keeps your dumps restorable with the tools
you already have. MySQL dumps are plain SQL and do not have this constraint.

### Database user
A read-only user is enough:

```sql
-- PostgreSQL
create user backup with password '...';
grant connect on database app to backup;
grant usage on schema public to backup;
grant select on all tables in schema public to backup;
grant select on all sequences in schema public to backup;
alter default privileges in schema public grant select on tables to backup;
alter default privileges in schema public grant select on sequences to backup;
```

```sql
-- MySQL 8
create user 'backup'@'%' identified by '...';
grant select, show view, trigger, lock tables, event on app.* to 'backup'@'%';
grant show_routine on *.* to 'backup'@'%';   -- optional; without it routines are skipped with a warning
```

### Bucket credentials
A key scoped to one bucket with object read, write and delete. Delete is only needed for retention;
with a write-only key set `KEEP_LAST`/`KEEP_DAYS` to 0 and use a bucket lifecycle rule instead. Add a
lifecycle rule that aborts incomplete multipart uploads after a day as well; a container that is
`SIGKILL`ed mid-upload cannot clean up after itself.

## Deploying

### Docker Compose
See [`docker-compose.example.yml`](docker-compose.example.yml). Put the service next to your database
and point `DATABASE_URL` at the service name; nothing needs to be exposed to the internet.

### Railway
Two shapes work. Either way the container reaches your database over Railway's private network
(`<service>.railway.internal`), so the database needs no public TCP proxy and no allow-list.

1. **Long-running service** (recommended): deploy this image as a new service, set the variables
   below, leave `SCHEDULE` as a cron expression. Railway restarts it if it dies; the Docker healthcheck
   reports a failed last run.
2. **Railway cron**: deploy the same image, set `SCHEDULE=once`, and set the service's *Cron Schedule*
   in its settings. Each run starts the container, backs up, and exits.

Reference the database's variables rather than copying them:
`DATABASE_URL=${{Postgres.DATABASE_URL}}` (or `DATABASE_PRIVATE_URL` on older projects).

### Render
[`render.yaml`](render.yaml) defines a cron job from the published image with `SCHEDULE=once` (the
file is written to Render's Blueprint spec but has not been deployed by us yet; tell us if it needs a fix). Use the
database's **external** connection string; Render cron jobs run outside the private network of a
single service group unless they are in the same Blueprint.

### GitHub Actions
```yaml
name: nightly backup
on:
  schedule: [{ cron: "0 2 * * *" }]
  workflow_dispatch:
jobs:
  backup:
    runs-on: ubuntu-latest
    steps:
      - uses: siddhujz/dumpling-backup@v0.1.0
        with:
          database_url: ${{ secrets.DATABASE_URL }}
          s3_endpoint: https://<accountid>.r2.cloudflarestorage.com
          s3_bucket: db-backups
          s3_access_key_id: ${{ secrets.S3_ACCESS_KEY_ID }}
          s3_secret_access_key: ${{ secrets.S3_SECRET_ACCESS_KEY }}
          keep_last: "14"
```
The database must be reachable from GitHub's runners (a public host with TLS, or a hosted provider
such as Neon, Supabase's session pooler, Railway's TCP proxy). The action pulls the published
`ghcr.io/siddhujz/dumpling-backup:18` image (PostgreSQL 18 client); a run takes well under a minute
plus the dump itself.

### Kubernetes, Nomad, a plain VM
Any scheduler that can run a container with environment variables works: use `SCHEDULE=once` under
an external scheduler (CronJob), or the internal cron under a Deployment with one replica.

## Configuration

Everything is an environment variable. Problems are reported all at once at startup, exit code 2.

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | | `postgres://`, `postgresql://`, `mysql://` or `mariadb://` URL. Postgres `sslmode` and other query parameters are passed through to `pg_dump`; a `password=` parameter is moved out of the command line. Write a literal `%` in the password as `%25`. |
| `DB_ENGINE`, `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `DB_SSL` | | Alternative to `DATABASE_URL` for platforms that hand out discrete variables. |
| `S3_BUCKET` | | Bucket name. Required. |
| `S3_ENDPOINT` | Amazon S3 | Endpoint URL for R2, B2, Wasabi, Spaces, Hetzner, MinIO. |
| `S3_REGION` | `auto` with an endpoint, `us-east-1` without | Region (`auto` works for R2; use the real region for S3 and B2). |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | | Credentials. `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` are accepted too. |
| `S3_PREFIX` | | Key prefix inside the bucket. |
| `S3_FORCE_PATH_STYLE` | `false` | `true` for MinIO and other path-style endpoints. |
| `BACKUP_NAME` | database name | Folder inside the bucket. Files land at `<prefix>/<name>/<UTC timestamp>.dump` (Postgres) or `.sql.gz` (MySQL), `.enc` appended when encrypted. |
| `SCHEDULE` | `0 2 * * *` | Cron expression (5 or 6 fields, or `@daily`, `@hourly`), or `once` to run one backup and exit. |
| `CRON_TZ` | UTC | IANA timezone for the cron expression, e.g. `Asia/Kolkata`. |
| `RUN_ON_START` | `true` | Also run a backup when the container starts. |
| `KEEP_LAST` | `0` | Keep this many newest backups; `0` keeps all. |
| `KEEP_DAYS` | `0` | Delete backups older than this many days; `0` keeps all. Both rules apply when both are set. |
| `PASSPHRASE` | | Encrypt each file with AES-256-CBC, OpenSSL `enc -pbkdf2` compatible. Keep it somewhere other than the bucket. |
| `WEBHOOK_URL` | | Slack or Discord incoming webhook, or any URL that accepts a JSON POST. Called on failure. |
| `NOTIFY_ON_SUCCESS` | `false` | Also call the webhook on success. |
| `HEALTHCHECK_URL` | | Pinged with GET after each successful run; `<url>/fail` after a failed one (healthchecks.io convention). |
| `MAX_DUMP_GB` | none | Kill the run if the dump exceeds twice this size. |
| `MAX_RUN_MINUTES` | none | Wall-clock limit for one run. |
| `STALL_MINUTES` | `10` | Kill the run if the dump produces no output for this long. |
| `STATUS_FILE` | `/tmp/dumpling-backup/status.json` | Where the Docker healthcheck reads the last result. |
| `PG_DUMP_BIN`, `PG_RESTORE_BIN`, `MYSQLDUMP_BIN` | on `PATH` | Override the tool binaries. |

## Restoring

```bash
# PostgreSQL (pg_restore must be the same major as the image tag, or newer)
createdb restored
pg_restore --no-owner --no-acl -d restored 2026-10-18T02-00-00Z.dump

# MySQL / MariaDB
gunzip < 2026-10-18T02-00-00Z.sql.gz | mysql restored

# Encrypted files first:
openssl enc -d -aes-256-cbc -pbkdf2 -in 2026-10-18T02-00-00Z.dump.enc -out 2026-10-18T02-00-00Z.dump -pass pass:YOUR_PASSPHRASE
```

Run a restore drill once a quarter: download the newest file, restore it into a throwaway database,
count the rows in a table you care about, and write down how long it took. A backup you have never
restored is a hypothesis.

## How verification works

The raw dump is tapped before compression and encryption. For PostgreSQL the tap is piped into
`pg_restore --list`, which parses the custom-format archive and prints its table of contents; the run
is marked verified only if that succeeds and lists at least one object, and the log shows what was
found ("142 tables with data, 96 indexes, 611 entries"). For MySQL the stream is checked for
`mysqldump`'s `-- Dump completed` trailer, which a truncated dump never has, and `CREATE TABLE`
statements are counted. A run whose archive fails that check is reported as failed: exit code 1 in
`once` mode, `backup.failed` on the webhook, unhealthy in the status file. The file itself is kept so
you can look at it, and retention is skipped so no verified older backup is deleted to make room for
it. Independently of that, if the dump tool exits non-zero the upload is failed and the partial
object deleted, so a `pg_dump` that died halfway is never left in the bucket as a plausible-looking
file.

This proves the archive is well-formed and complete, which catches the common silent failures. It
does not prove the data restores into a live server with your extensions and roles; that is what the
restore drill above is for.

## What the webhook receives

```json
{
  "text": "Backup app FAILED: pg_dump exited with code 1: FATAL: password authentication failed",
  "content": "Backup app FAILED: ...",
  "event": "backup.failed",
  "backup": "app",
  "status": "failed",
  "sizeBytes": null, "objectKey": null, "verified": null, "verifyNote": null, "warning": null,
  "error": "pg_dump exited with code 1: FATAL: password authentication failed",
  "durationMs": 812,
  "at": "2026-10-18T02:00:01.230Z"
}
```
`text` renders in Slack, `content` in Discord; everything else is for your own receivers.

## Security notes

- The database password is passed to the dump tool through `PGPASSWORD` / `MYSQL_PWD`, never on the
  command line, and the tools get a minimal environment: your bucket keys and webhook URL are not
  visible to them. Nothing secret is written to the log or the status file.
- The container runs as a non-root user and writes only the status file under `/tmp`.
- TLS to PostgreSQL follows `sslmode` (default `require` when the URL has none). Use `verify-full`
  with `sslrootcert` in the URL when your provider gives you a CA. MySQL TLS is `--ssl`/`--ssl-mode=REQUIRED`
  when the URL asks for it; `ssl-mode=VERIFY_IDENTITY` (or `VERIFY_CA`) turns on certificate
  verification with either client.
- Encryption is client-side with your passphrase; whoever holds the bucket cannot read the files.
- Retention lists the backup folder and deletes only objects whose names match this tool's own
  timestamp pattern directly inside that folder. Your other files in the same prefix are never touched.

## If you would rather not run a container

[Dumpling](https://getdumpling.dev/r/container) is the hosted version of the same engine: the same
`pg_dump`/`mysqldump` into your own bucket, the same in-stream verification, plus run history, missed-run
detection, email alerts and a page per backup, with no container to keep alive. One database with daily
backups is free. The files are byte-for-byte what this container writes, so you can move between the
two without converting anything.

## Development

```bash
npm install
npm run verify            # typecheck, tests, build
PGBIN=/opt/homebrew/opt/postgresql@17/bin npm test   # the integration test needs initdb/pg_ctl/pg_dump
docker build --build-arg PG_MAJOR=17 -t dumpling-backup:17 .
```

The integration test starts a throwaway PostgreSQL cluster and a fake S3 (`s3rver`), backs up through
the real `pg_dump`, checks verification, retention, encryption, failure cleanup and abort handling. It
skips silently when the PostgreSQL binaries are missing; a green run should say 2 test files.

## Licence

MIT.
