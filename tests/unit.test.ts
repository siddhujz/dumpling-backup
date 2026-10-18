import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { ConfigError, describeDatabase, loadConfig, parseDatabaseUrl } from "../src/config";
import { buildDumpCommand } from "../src/dump";
import { createOpenSslEncryptStream } from "../src/encrypt";
import { webhookPayload } from "../src/notify";
import { BACKUP_FILE_RE, backupFileName, retainableBackups, staleKeys } from "../src/retention";
import { partSizeFor } from "../src/s3";
import { evaluateHealth } from "../src/status";
import { createDumpVerifier } from "../src/verify";

const PASSWORD = "s3cr3t-P@ss word";
const BASE_ENV = {
  S3_BUCKET: "backups",
  S3_ACCESS_KEY_ID: "AKIA",
  S3_SECRET_ACCESS_KEY: "verysecretkey",
  S3_ENDPOINT: "https://example.r2.cloudflarestorage.com",
};

describe("config", () => {
  it("parses a postgres URL and strips the password from the URI passed to pg_dump", () => {
    const problems: string[] = [];
    const d = parseDatabaseUrl(`postgresql://app_user:${encodeURIComponent(PASSWORD)}@db.example.com:6543/appdb?sslmode=require`, problems)!;
    expect(problems).toEqual([]);
    expect(d).toMatchObject({ engine: "postgres", host: "db.example.com", port: 6543, dbName: "appdb", username: "app_user", password: PASSWORD, ssl: true });
    expect(d.uri).not.toContain(encodeURIComponent(PASSWORD));
    expect(d.uri).not.toContain("s3cr3t");
    expect(d.uri).toContain("sslmode=require");
    expect(d.uri).toContain("app_user@db.example.com:6543/appdb");
  });

  it("defaults: postgres TLS on, sslmode=disable turns it off; mysql port 3306 and TLS off", () => {
    const p: string[] = [];
    expect(parseDatabaseUrl("postgres://u:p@h/db", p)).toMatchObject({ port: 5432, ssl: true });
    expect(parseDatabaseUrl("postgres://u:p@h/db?sslmode=disable", p)).toMatchObject({ ssl: false });
    expect(parseDatabaseUrl("mysql://u:p@h/db", p)).toMatchObject({ engine: "mysql", port: 3306, ssl: false });
    expect(parseDatabaseUrl("mariadb://u:p@h/db?ssl-mode=REQUIRED", p)).toMatchObject({ engine: "mysql", ssl: true });
    expect(p).toEqual([]);
  });

  it("rejects unknown schemes and malformed URLs", () => {
    const p: string[] = [];
    expect(parseDatabaseUrl("mongodb://u:p@h/db", p)).toBeNull();
    expect(parseDatabaseUrl("not a url", p)).toBeNull();
    expect(p).toHaveLength(2);
  });

  it("reports every problem at once", () => {
    try {
      loadConfig({ DATABASE_URL: "mongodb://x", SCHEDULE: "soon", KEEP_LAST: "-1", WEBHOOK_URL: "ftp://x" });
      throw new Error("expected ConfigError");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const problems = (e as ConfigError).problems;
      expect(problems.some((s) => s.startsWith("DATABASE_URL must start"))).toBe(true);
      expect(problems.some((s) => s.startsWith("S3_BUCKET"))).toBe(true);
      expect(problems.some((s) => s.startsWith("S3_ACCESS_KEY_ID"))).toBe(true);
      expect(problems.some((s) => s.startsWith("SCHEDULE"))).toBe(true);
      expect(problems.some((s) => s.startsWith("KEEP_LAST"))).toBe(true);
      expect(problems.some((s) => s.startsWith("WEBHOOK_URL"))).toBe(true);
    }
  });

  it("applies defaults and derives the backup name from the database", () => {
    const cfg = loadConfig({ ...BASE_ENV, DATABASE_URL: "postgres://u:p@h/appdb" });
    expect(cfg.backupName).toBe("appdb");
    expect(cfg.schedule).toBe("0 2 * * *");
    expect(cfg.runOnStart).toBe(true);
    expect(cfg.keepLast).toBe(0);
    expect(cfg.keepDays).toBe(0);
    expect(cfg.stallMs).toBe(10 * 60_000);
    expect(cfg.maxRunMs).toBe(0);
    expect(cfg.storage.region).toBe("auto");
  });

  it("accepts discrete DB_* variables and builds the pg URI from them", () => {
    const cfg = loadConfig({ ...BASE_ENV, DB_ENGINE: "postgres", DB_HOST: "h", DB_NAME: "d", DB_USER: "u", DB_PASSWORD: PASSWORD, DB_SSL: "false", BACKUP_NAME: "nightly" });
    expect(cfg.database.uri).toBe("postgresql://u@h:5432/d?sslmode=prefer");
    expect(cfg.database.password).toBe(PASSWORD);
    expect(cfg.backupName).toBe("nightly");
  });

  it("moves a ?password= query parameter out of the URI handed to argv and uses it", () => {
    const p: string[] = [];
    const d = parseDatabaseUrl("postgres://u@h/db?password=TOPSECRET&sslmode=require&sslpassword=KEYPASS", p)!;
    expect(p).toEqual([]);
    expect(d.password).toBe("TOPSECRET");
    expect(d.uri).not.toContain("TOPSECRET");
    expect(d.uri).not.toContain("KEYPASS");
    expect(d.uri).toContain("sslmode=require");
  });

  it("turns malformed percent-encoding and an invalid DB_HOST into config errors, not crashes", () => {
    expect(() => loadConfig({ ...BASE_ENV, DATABASE_URL: "postgres://u:pa%ssword@h/db" })).toThrow(/percent-encoding/);
    expect(() => loadConfig({ ...BASE_ENV, DB_ENGINE: "postgres", DB_HOST: "my host", DB_NAME: "d", DB_USER: "u", DB_PASSWORD: "p" })).toThrow(/DB_HOST is not a valid host name/);
  });

  it("accepts cron nicknames, defaults the region by endpoint, and names the derived-folder problem", () => {
    expect(loadConfig({ ...BASE_ENV, DATABASE_URL: "postgres://u:p@h/db", SCHEDULE: "@daily" }).schedule).toBe("@daily");
    expect(loadConfig({ ...BASE_ENV, S3_ENDPOINT: "", DATABASE_URL: "postgres://u:p@h/db" }).storage.region).toBe("us-east-1");
    expect(loadConfig({ ...BASE_ENV, DATABASE_URL: "postgres://u:p@h/db" }).storage.region).toBe("auto");
    expect(() => loadConfig({ ...BASE_ENV, DATABASE_URL: "postgres://u:p@h/my%20db" })).toThrow(/BACKUP_NAME is required because the database name/);
  });

  it("rejects a backup name that would not be a safe folder", () => {
    expect(() => loadConfig({ ...BASE_ENV, DATABASE_URL: "postgres://u:p@h/db", BACKUP_NAME: "../etc" })).toThrow(/BACKUP_NAME/);
  });
});

describe("dump command keeps the password out of argv and logs", () => {
  const bins = { pgDumpBin: "pg_dump", mysqldumpBin: "mysqldump" };

  it("postgres: password only in PGPASSWORD, URI without it as --dbname", () => {
    const d = parseDatabaseUrl(`postgres://u:${encodeURIComponent(PASSWORD)}@h:5432/db?sslmode=require`, [])!;
    const { cmd, args, envVars } = buildDumpCommand(bins, d);
    expect(cmd).toBe("pg_dump");
    expect(args.join(" ")).not.toContain("s3cr3t");
    expect(args).toContain("--format=custom");
    expect(args[args.indexOf("--dbname") + 1]).toContain("sslmode=require");
    expect(envVars.PGPASSWORD).toBe(PASSWORD);
    expect(Object.keys(envVars).sort()).toEqual(["HOME", "LANG", "PATH", "PGCONNECT_TIMEOUT", "PGPASSWORD"]);
    expect(describeDatabase(d)).not.toContain("s3cr3t");
  });

  it("mysql: password only in MYSQL_PWD, --no-tablespaces always, TLS flag when asked", () => {
    const d = parseDatabaseUrl(`mysql://u:${encodeURIComponent(PASSWORD)}@h/db?ssl=true`, [])!;
    const { args, envVars } = buildDumpCommand(bins, d);
    expect(args.join(" ")).not.toContain("s3cr3t");
    expect(args).toContain("--no-tablespaces");
    expect(args).toContain("--single-transaction");
    expect(args.some((a) => a.startsWith("--ssl"))).toBe(true);
    expect(envVars.MYSQL_PWD).toBe(PASSWORD);
    expect(buildDumpCommand(bins, d, { routines: false }).args).not.toContain("--routines");
  });

  it("mysql: VERIFY_IDENTITY is honoured, not downgraded to REQUIRED", () => {
    const d = parseDatabaseUrl("mysql://u:p@h/db?ssl-mode=VERIFY_IDENTITY", [])!;
    expect(d.mysqlVerify).toBe(true);
    const { args } = buildDumpCommand(bins, d);
    // the local flavour decides the spelling; either way the verify flag must be present
    expect(args.some((a) => a === "--ssl-mode=VERIFY_IDENTITY" || a === "--ssl-verify-server-cert")).toBe(true);
    expect(args).not.toContain("--ssl-mode=REQUIRED");
  });
});

describe("file names and retention", () => {
  it("names files so retention recognises them", () => {
    const at = new Date("2026-10-18T02:00:05.123Z");
    expect(backupFileName("postgres", false, at)).toBe("2026-10-18T02-00-05Z.dump");
    expect(backupFileName("mysql", true, at)).toBe("2026-10-18T02-00-05Z.sql.gz.enc");
    expect(BACKUP_FILE_RE.test(backupFileName("postgres", true, at))).toBe(true);
  });

  it("only touches our own files directly in the folder", () => {
    const mk = (key: string, daysAgo: number) => ({ key, size: 1, lastModified: new Date(Date.now() - daysAgo * 86400_000) });
    const objects = [
      mk("pre/app/2026-10-18T02-00-00Z.dump", 0),
      mk("pre/app/2026-10-17T02-00-00Z.dump", 1),
      mk("pre/app/2026-10-10T02-00-00Z.dump.enc", 8),
      mk("pre/app/notes.txt", 0), // user's file
      mk("pre/app/sub/2026-10-01T02-00-00Z.dump", 17), // nested: not ours
      mk("pre/app2/2026-10-18T02-00-00Z.dump", 0), // sibling folder
    ];
    const ours = retainableBackups(objects, "pre/app");
    expect(ours.map((o) => o.key)).toEqual(["pre/app/2026-10-18T02-00-00Z.dump", "pre/app/2026-10-17T02-00-00Z.dump", "pre/app/2026-10-10T02-00-00Z.dump.enc"]);
    expect(staleKeys(ours, 2)).toEqual(["pre/app/2026-10-10T02-00-00Z.dump.enc"]);
    expect(staleKeys(ours, 0, 7)).toEqual(["pre/app/2026-10-10T02-00-00Z.dump.enc"]);
    expect(staleKeys(ours, 1, 7)).toEqual(["pre/app/2026-10-17T02-00-00Z.dump", "pre/app/2026-10-10T02-00-00Z.dump.enc"]);
    expect(staleKeys(ours, 0, 0)).toEqual([]);
  });

  it("sizes multipart parts for the ceiling", () => {
    expect(partSizeFor(0)).toBe(64 * 1024 ** 2);
    expect(partSizeFor(2 * 1024 ** 4)).toBeGreaterThan(64 * 1024 ** 2); // 2 TB cap needs bigger parts
  });
});

describe("verifier (mysql, no binaries needed)", () => {
  async function run(chunks: string[]) {
    const v = createDumpVerifier("mysql", "pg_restore", {});
    const src = Readable.from(chunks.map((c) => Buffer.from(c)));
    await new Promise<void>((res, rej) => {
      src.pipe(v.tap).on("finish", res).on("error", rej).resume();
    });
    return v.result;
  }
  it("accepts a complete dump and counts tables across chunk boundaries", async () => {
    const r = await run(["-- MySQL dump\nCREATE TABLE `a` (id int);\nINSERT INTO a VALUES (1);\nCREATE TA", "BLE `b` (id int);\n", "-- Dump completed on 2026-10-18\n"]);
    expect(r).toEqual({ verified: true, note: "2 tables, dump trailer present" });
  });
  it("rejects a truncated dump", async () => {
    const r = await run(["CREATE TABLE `a` (id int);\nINSERT INTO a VALUES (1);\n"]);
    expect(r.verified).toBe(false);
    expect(r.note).toMatch(/trailer/);
  });
});

describe("encryption is OpenSSL enc -aes-256-cbc -pbkdf2 compatible", () => {
  it("produces Salted__ header and decrypts with PBKDF2-SHA256 10000 iterations", async () => {
    const plain = Buffer.from("hello dumpling ".repeat(100));
    const chunks: Buffer[] = [];
    const enc = createOpenSslEncryptStream("correct horse");
    await new Promise<void>((res, rej) => {
      enc.on("data", (c: Buffer) => chunks.push(c)).on("end", res).on("error", rej);
      enc.end(plain);
    });
    const out = Buffer.concat(chunks);
    expect(out.subarray(0, 8).toString()).toBe("Salted__");
    const salt = out.subarray(8, 16);
    const keyIv = crypto.pbkdf2Sync("correct horse", salt, 10000, 48, "sha256");
    const decipher = crypto.createDecipheriv("aes-256-cbc", keyIv.subarray(0, 32), keyIv.subarray(32, 48));
    const dec = Buffer.concat([decipher.update(out.subarray(16)), decipher.final()]);
    expect(dec.equals(plain)).toBe(true);
  });
});

describe("webhook payload and health", () => {
  it("renders for Slack/Discord and carries no secrets", () => {
    const p = webhookPayload({ backupName: "app" }, { status: "failed", error: "pg_dump exited with code 1: FATAL: password authentication failed", durationMs: 12 });
    expect(p.text).toBe(p.content);
    expect(p.text).toMatch(/^Backup app FAILED/);
    expect(p.event).toBe("backup.failed");
    const ok = webhookPayload({ backupName: "app" }, { status: "success", sizeBytes: 2048, verified: true, verifyNote: "3 tables with data", durationMs: 1000, objectKey: "app/x.dump" });
    expect(ok.text).toContain("2.00 KB");
    expect(ok.text).toContain("verified (3 tables with data)");
  });

  it("evaluates container health", () => {
    const now = Date.parse("2026-10-18T12:00:00Z");
    expect(evaluateHealth(null).healthy).toBe(false);
    expect(evaluateHealth({ state: "idle", lastStatus: "failed", lastRunAt: "x", lastError: "boom", lastVerified: false, nextRunAt: null, updatedAt: "x" }, now).healthy).toBe(false);
    expect(evaluateHealth({ state: "idle", lastStatus: "success", lastRunAt: "x", lastError: null, lastVerified: true, nextRunAt: "2026-10-18T10:00:00Z", updatedAt: "x" }, now).healthy).toBe(false);
    expect(evaluateHealth({ state: "running", lastStatus: "success", lastRunAt: "x", lastError: null, lastVerified: true, nextRunAt: "2026-10-18T10:00:00Z", updatedAt: "x" }, now).healthy).toBe(true);
    expect(evaluateHealth({ state: "idle", lastStatus: null, lastRunAt: null, lastError: null, lastVerified: null, nextRunAt: "2026-10-19T02:00:00Z", updatedAt: "x" }, now).healthy).toBe(true);
  });
});
