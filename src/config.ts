/**
 * All configuration comes from environment variables. Everything is validated up front and every
 * problem is reported at once, so a misconfigured container fails in seconds with a list, not at
 * 02:00 with one line.
 */
export type Engine = "postgres" | "mysql";

export interface DatabaseConfig {
  engine: Engine;
  host: string;
  port: number;
  dbName: string;
  username: string;
  password: string;
  ssl: boolean;
  /** MySQL only: the URL asked for certificate verification (ssl-mode=VERIFY_CA|VERIFY_IDENTITY). */
  mysqlVerify?: boolean;
  /** Postgres only: the connection URI with the password removed, passed to pg_dump as --dbname so sslmode and other params survive. */
  uri?: string;
}

export interface StorageConfig {
  endpoint?: string;
  region: string;
  bucket: string;
  prefix?: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

export interface Config {
  database: DatabaseConfig;
  storage: StorageConfig;
  backupName: string;
  /** Cron expression, or "once" to run a single backup and exit. */
  schedule: string;
  cronTimezone?: string;
  runOnStart: boolean;
  keepLast: number;
  keepDays: number;
  passphrase?: string;
  webhookUrl?: string;
  notifyOnSuccess: boolean;
  healthcheckUrl?: string;
  stallMs: number;
  maxRunMs: number;
  maxDumpBytes: number;
  statusFile: string;
  pgDumpBin: string;
  pgRestoreBin: string;
  mysqldumpBin: string;
}

export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v === "") return fallback;
  return /^(1|true|yes|on)$/i.test(v);
}

function int(name: string, v: string | undefined, fallback: number, problems: string[], min = 0): number {
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) problems.push(`${name} must be an integer >= ${min}`);
  return n;
}

const PG_SSL_ON = new Set(["require", "verify-ca", "verify-full"]);

/** Parses postgres://, postgresql://, mysql:// and mariadb:// URIs. Returns null with a problem recorded when it cannot. */
export function parseDatabaseUrl(raw: string, problems: string[]): DatabaseConfig | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    problems.push("DATABASE_URL is not a valid URL");
    return null;
  }
  const proto = u.protocol.replace(/:$/, "");
  const engine: Engine | null = proto === "postgres" || proto === "postgresql" ? "postgres" : proto === "mysql" || proto === "mariadb" ? "mysql" : null;
  if (!engine) {
    problems.push(`DATABASE_URL must start with postgres://, postgresql://, mysql:// or mariadb:// (got ${proto}://)`);
    return null;
  }
  let dbName: string, username: string, password: string;
  try {
    dbName = decodeURIComponent(u.pathname.replace(/^\//, ""));
    username = decodeURIComponent(u.username);
    password = decodeURIComponent(u.password);
  } catch {
    problems.push("DATABASE_URL has invalid percent-encoding; write a literal % in the password as %25");
    return null;
  }
  // libpq also accepts the password as a query parameter; it must not stay in the URI we hand to argv.
  const qpPassword = u.searchParams.get("password");
  if (qpPassword && !password) password = qpPassword;
  if (!dbName) problems.push("DATABASE_URL has no database name after the host");
  if (!username) problems.push("DATABASE_URL has no user name");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!host) problems.push("DATABASE_URL has no host");
  const port = u.port ? Number(u.port) : engine === "postgres" ? 5432 : 3306;
  let ssl: boolean;
  if (engine === "postgres") {
    const mode = u.searchParams.get("sslmode");
    ssl = mode ? PG_SSL_ON.has(mode) : true;
  } else {
    const mode = u.searchParams.get("ssl-mode") ?? u.searchParams.get("ssl");
    ssl = mode ? /^(1|true|required|verify_ca|verify_identity|preferred)$/i.test(mode) : false;
  }
  const cfg: DatabaseConfig = { engine, host, port, dbName, username, password, ssl };
  if (engine === "mysql") cfg.mysqlVerify = /^(verify_ca|verify_identity)$/i.test(u.searchParams.get("ssl-mode") ?? "");
  if (engine === "postgres") {
    const stripped = new URL(raw);
    stripped.password = "";
    stripped.searchParams.delete("password");
    stripped.searchParams.delete("sslpassword"); // a client-key passphrase; cannot be supplied safely through a URI on the command line
    cfg.uri = stripped.toString();
  }
  return cfg;
}

function discreteDatabase(env: NodeJS.ProcessEnv, problems: string[]): DatabaseConfig | null {
  const engine = (env.DB_ENGINE ?? "").toLowerCase();
  if (engine !== "postgres" && engine !== "mysql") {
    problems.push("Set DATABASE_URL, or DB_ENGINE (postgres|mysql) with DB_HOST, DB_NAME, DB_USER and DB_PASSWORD");
    return null;
  }
  const host = env.DB_HOST ?? "";
  const dbName = env.DB_NAME ?? "";
  const username = env.DB_USER ?? "";
  if (!host) problems.push("DB_HOST is required");
  if (!dbName) problems.push("DB_NAME is required");
  if (!username) problems.push("DB_USER is required");
  const port = int("DB_PORT", env.DB_PORT, engine === "postgres" ? 5432 : 3306, problems, 1);
  const ssl = bool(env.DB_SSL, engine === "postgres");
  const cfg: DatabaseConfig = { engine, host, port, dbName, username, password: env.DB_PASSWORD ?? "", ssl };
  if (engine === "postgres" && host && username && dbName) {
    try {
      const u = new URL(`postgresql://${encodeURIComponent(username)}@${host.includes(":") ? `[${host}]` : host}:${port}/${encodeURIComponent(dbName)}`);
      u.searchParams.set("sslmode", ssl ? "require" : "prefer");
      cfg.uri = u.toString();
    } catch {
      problems.push("DB_HOST is not a valid host name");
    }
  }
  return cfg;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const problems: string[] = [];

  const database = env.DATABASE_URL ? parseDatabaseUrl(env.DATABASE_URL, problems) : discreteDatabase(env, problems);

  const bucket = env.S3_BUCKET ?? "";
  if (!bucket) problems.push("S3_BUCKET is required");
  const endpoint = env.S3_ENDPOINT || undefined;
  if (endpoint && !/^https?:\/\//.test(endpoint)) problems.push("S3_ENDPOINT must start with https:// (or http:// for a local MinIO)");
  const accessKeyId = env.S3_ACCESS_KEY_ID ?? env.AWS_ACCESS_KEY_ID ?? "";
  const secretAccessKey = env.S3_SECRET_ACCESS_KEY ?? env.AWS_SECRET_ACCESS_KEY ?? "";
  if (!accessKeyId || !secretAccessKey) problems.push("S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY are accepted too)");
  const storage: StorageConfig = {
    endpoint,
    region: env.S3_REGION || (endpoint ? "auto" : "us-east-1"),
    bucket,
    prefix: env.S3_PREFIX || undefined,
    accessKeyId,
    secretAccessKey,
    forcePathStyle: bool(env.S3_FORCE_PATH_STYLE, false),
  };

  const backupName = env.BACKUP_NAME || database?.dbName || "";
  if (!NAME_RE.test(backupName)) {
    problems.push(
      env.BACKUP_NAME
        ? "BACKUP_NAME must be 1-64 characters: letters, digits, dot, underscore, dash (it becomes the folder in the bucket)"
        : `BACKUP_NAME is required because the database name "${backupName}" is not usable as a folder name (letters, digits, dot, underscore, dash)`,
    );
  }

  const schedule = (env.SCHEDULE || "0 2 * * *").trim();
  if (schedule !== "once" && !schedule.startsWith("@") && schedule.split(/\s+/).length < 5) problems.push('SCHEDULE must be a cron expression (e.g. "0 2 * * *" or @daily) or "once"');

  const webhookUrl = env.WEBHOOK_URL || undefined;
  if (webhookUrl && !/^https?:\/\//.test(webhookUrl)) problems.push("WEBHOOK_URL must start with https://");
  const healthcheckUrl = env.HEALTHCHECK_URL || undefined;
  if (healthcheckUrl && !/^https?:\/\//.test(healthcheckUrl)) problems.push("HEALTHCHECK_URL must start with https://");

  const passphrase = env.PASSPHRASE || undefined;
  if (passphrase !== undefined && passphrase.length < 8) problems.push("PASSPHRASE must be at least 8 characters");

  const cfg: Config = {
    database: database!,
    storage,
    backupName,
    schedule,
    cronTimezone: env.CRON_TZ || undefined,
    runOnStart: bool(env.RUN_ON_START, true),
    keepLast: int("KEEP_LAST", env.KEEP_LAST, 0, problems),
    keepDays: int("KEEP_DAYS", env.KEEP_DAYS, 0, problems),
    passphrase,
    webhookUrl,
    notifyOnSuccess: bool(env.NOTIFY_ON_SUCCESS, false),
    healthcheckUrl,
    stallMs: int("STALL_MINUTES", env.STALL_MINUTES, 10, problems, 1) * 60_000,
    maxRunMs: int("MAX_RUN_MINUTES", env.MAX_RUN_MINUTES, 0, problems) * 60_000,
    maxDumpBytes: int("MAX_DUMP_GB", env.MAX_DUMP_GB, 0, problems) * 1024 ** 3,
    statusFile: env.STATUS_FILE || "/tmp/dumpling-backup/status.json",
    pgDumpBin: env.PG_DUMP_BIN || "pg_dump",
    pgRestoreBin: env.PG_RESTORE_BIN || "pg_restore",
    mysqldumpBin: env.MYSQLDUMP_BIN || "mysqldump",
  };

  if (problems.length) throw new ConfigError(problems);
  return cfg;
}

export class ConfigError extends Error {
  constructor(public problems: string[]) {
    super(`Configuration problems:\n  - ${problems.join("\n  - ")}`);
  }
}

/** What may be printed about the target: engine, host, port and database, never credentials. */
export function describeDatabase(d: DatabaseConfig): string {
  return `${d.engine} ${d.host}:${d.port}/${d.dbName}${d.ssl ? " (tls)" : ""}`;
}
