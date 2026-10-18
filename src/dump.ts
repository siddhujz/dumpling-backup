import { spawnSync } from "node:child_process";
import type { Config, DatabaseConfig } from "./config";

/** The dump tool gets only what it needs; never the container's other variables (bucket keys, webhook URL). */
export function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME ?? "/tmp",
    LANG: process.env.LANG ?? "C.UTF-8",
    ...extra,
  } as NodeJS.ProcessEnv;
}

let mysqldumpFlavour: "mysql" | "mariadb" | null = null;
/** MariaDB's and Oracle's mysqldump accept different flags; detect once per process. */
export function detectMysqldumpFlavour(bin: string): "mysql" | "mariadb" {
  if (mysqldumpFlavour) return mysqldumpFlavour;
  const r = spawnSync(bin, ["--version"], { encoding: "utf8" });
  mysqldumpFlavour = /mariadb/i.test(`${r.stdout ?? ""}${r.stderr ?? ""}`) ? "mariadb" : "mysql";
  return mysqldumpFlavour;
}

export interface DumpCommand {
  cmd: string;
  args: string[];
  envVars: NodeJS.ProcessEnv;
}

/**
 * The password never appears in argv (visible to every process on the host): Postgres gets it via
 * PGPASSWORD and the URI without it; MySQL via MYSQL_PWD.
 */
export function buildDumpCommand(cfg: Pick<Config, "pgDumpBin" | "mysqldumpBin">, d: DatabaseConfig, opts: { routines?: boolean } = {}): DumpCommand {
  if (d.engine === "postgres") {
    // Custom format (-Fc) is compressed and restorable with pg_restore.
    return {
      cmd: cfg.pgDumpBin,
      args: ["--format=custom", "--no-password", "--no-owner", "--no-acl", "--dbname", d.uri!],
      envVars: childEnv({ PGPASSWORD: d.password, PGCONNECT_TIMEOUT: "15" }),
    };
  }
  const flavour = detectMysqldumpFlavour(cfg.mysqldumpBin);
  return {
    cmd: cfg.mysqldumpBin,
    args: [
      "--single-transaction",
      "--quick",
      ...(opts.routines === false ? [] : ["--routines"]),
      "--triggers",
      // MySQL 8.0.21+ needs the PROCESS privilege to dump tablespace metadata, which a scoped backup
      // user does not have; a logical restore never needs it. Both clients accept the flag.
      "--no-tablespaces",
      // Oracle mysqldump would otherwise embed SET @@GLOBAL.GTID_PURGED, which breaks restores elsewhere.
      ...(flavour === "mysql" ? ["--set-gtid-purged=OFF"] : []),
      // Verify modes are honoured, not downgraded: Oracle via ssl-mode, MariaDB via the separate verify flag.
      ...(d.ssl ? (flavour === "mysql" ? [`--ssl-mode=${d.mysqlVerify ? "VERIFY_IDENTITY" : "REQUIRED"}`] : ["--ssl", ...(d.mysqlVerify ? ["--ssl-verify-server-cert"] : [])]) : []),
      "--host",
      d.host,
      "--port",
      String(d.port),
      "--user",
      d.username,
      d.dbName,
    ],
    envVars: childEnv({ MYSQL_PWD: d.password }),
  };
}

/**
 * MySQL 8 needs the global SHOW_ROUTINE privilege (or SELECT on mysql.proc before 8.0.20) to dump
 * routines it did not define. A scoped backup user usually lacks it; the tables still matter more.
 */
export function isRoutinePrivilegeError(stderr: string): boolean {
  return /insufficient privileges to SHOW CREATE (PROCEDURE|FUNCTION)/i.test(stderr);
}

/** pg_dump refuses a server newer than itself; the fix is a newer image tag. */
export function isServerVersionMismatch(stderr: string): boolean {
  return /server version mismatch|aborting because of server version mismatch/i.test(stderr);
}
