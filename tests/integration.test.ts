/**
 * End to end: a real PostgreSQL cluster -> runBackup -> fake S3 (s3rver). Needs initdb/pg_ctl/pg_dump/
 * pg_restore locally; set PGBIN=/path/to/bin if they live somewhere unusual. Skipped without them.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { runBackup } from "../src/backup";
import { loadConfig } from "../src/config";
import { listBackups } from "../src/s3";

const PGBIN = [process.env.PGBIN, "/usr/lib/postgresql/16/bin", "/usr/lib/postgresql/17/bin", "/usr/lib/postgresql/18/bin", "/opt/homebrew/opt/postgresql@17/bin", "/opt/homebrew/opt/postgresql@18/bin", "/opt/homebrew/opt/postgresql@16/bin", "/usr/local/bin", "/usr/bin"].find((d) => d && fs.existsSync(path.join(d, "pg_ctl")));

async function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => res(p));
    });
  });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!PGBIN)("postgres -> s3 (real pg_dump, fake S3)", () => {
  let pgdir: string;
  let pgPort: number;
  let s3: { close: () => Promise<void> };
  let s3Port: number;
  let env: NodeJS.ProcessEnv;
  const lines: string[] = [];
  const log = (s: string) => lines.push(s);

  beforeAll(async () => {
    pgdir = fs.mkdtempSync(path.join(os.tmpdir(), "dbk-pg-"));
    pgPort = await freePort();
    const sh = (cmd: string) => {
      const r = spawnSync("sh", ["-c", cmd], { encoding: "utf8" });
      if (r.status !== 0) throw new Error(`${cmd}\n${r.stdout}\n${r.stderr}`);
    };
    const data = path.join(pgdir, "data");
    sh(`${PGBIN}/initdb -D ${data} -U postgres --auth=trust -E UTF8 >/dev/null`);
    sh(`${PGBIN}/pg_ctl -D ${data} -o "-p ${pgPort} -k ${pgdir} -c listen_addresses=127.0.0.1" -l ${pgdir}/log start -w >/dev/null`);
    const psql = (db: string, sql: string) => execFileSync(`${PGBIN}/psql`, ["-h", "127.0.0.1", "-p", String(pgPort), "-U", "postgres", "-d", db, "-c", sql]);
    psql("postgres", "create database app");
    psql("app", "create table t(id serial primary key, v text); create index t_v on t(v); insert into t(v) select md5(random()::text) from generate_series(1, 5000);");

    const S3rver = (await import("s3rver")).default;
    const s3dir = fs.mkdtempSync(path.join(os.tmpdir(), "dbk-s3-"));
    s3Port = await freePort();
    const server = new S3rver({ port: s3Port, address: "127.0.0.1", silent: true, directory: s3dir, configureBuckets: [{ name: "backups", configs: [] }] });
    await server.run();
    s3 = server;

    env = {
      DATABASE_URL: `postgresql://postgres@127.0.0.1:${pgPort}/app?sslmode=disable`,
      S3_ENDPOINT: `http://127.0.0.1:${s3Port}`,
      S3_FORCE_PATH_STYLE: "true",
      S3_REGION: "us-east-1",
      S3_BUCKET: "backups",
      S3_ACCESS_KEY_ID: "S3RVER",
      S3_SECRET_ACCESS_KEY: "S3RVER",
      S3_PREFIX: "team",
      BACKUP_NAME: "app",
      PG_DUMP_BIN: `${PGBIN}/pg_dump`,
      PG_RESTORE_BIN: `${PGBIN}/pg_restore`,
    };
  }, 60_000);

  afterAll(async () => {
    try {
      await s3?.close();
    } catch {}
    try {
      spawnSync("sh", ["-c", `${PGBIN}/pg_ctl -D ${pgdir}/data stop -m immediate`], { encoding: "utf8" });
    } catch {}
  });

  it("backs up, verifies in-stream, names the object as retention expects", async () => {
    const cfg = loadConfig(env);
    const r = await runBackup(cfg, { log });
    expect(r.status, r.error).toBe("success");
    expect(r.verified).toBe(true);
    expect(r.verifyNote).toMatch(/^1 table with data, 1 index, \d+ entries$/); // the primary key is listed as a CONSTRAINT, t_v as the index
    expect(r.objectKey).toMatch(/^team\/app\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.dump$/);
    expect(r.sizeBytes!).toBeGreaterThan(10_000);
    const objects = await listBackups(cfg.storage, "app");
    expect(objects.map((o) => o.key)).toEqual([r.objectKey]);
    expect(lines.join("\n")).not.toContain("S3RVER"); // no credentials in the log
  });

  it("retention keeps the newest N and only our files", async () => {
    await wait(1100); // file names have second resolution
    const cfg = loadConfig({ ...env, KEEP_LAST: "1" });
    const r = await runBackup(cfg, { log });
    expect(r.status, r.error).toBe("success");
    const objects = await listBackups(cfg.storage, "app");
    expect(objects).toHaveLength(1);
    expect(objects[0].key).toBe(r.objectKey);
    expect(lines.some((l) => /Retention: deleted 1 old backup/.test(l))).toBe(true);
  });

  it("encrypts in OpenSSL format and the decrypted archive is a valid pg_dump", async () => {
    await wait(1100);
    const cfg = loadConfig({ ...env, BACKUP_NAME: "app-enc", PASSPHRASE: "correct horse battery" });
    const r = await runBackup(cfg, { log });
    expect(r.status, r.error).toBe("success");
    expect(r.verified).toBe(true); // verification taps before encryption
    expect(r.objectKey).toMatch(/\.dump\.enc$/);
    // Fetch the object back through the SDK and decrypt it the way `openssl enc -d -aes-256-cbc -pbkdf2` would.
    const { S3Client, GetObjectCommand } = await import("@aws-sdk/client-s3");
    const client = new S3Client({ endpoint: cfg.storage.endpoint, region: cfg.storage.region, forcePathStyle: true, credentials: { accessKeyId: "S3RVER", secretAccessKey: "S3RVER" } });
    const got = await client.send(new GetObjectCommand({ Bucket: "backups", Key: r.objectKey }));
    const enc = Buffer.from(await got.Body!.transformToByteArray());
    client.destroy();
    expect(enc.subarray(0, 8).toString()).toBe("Salted__");
    const keyIv = crypto.pbkdf2Sync("correct horse battery", enc.subarray(8, 16), 10000, 48, "sha256");
    const decipher = crypto.createDecipheriv("aes-256-cbc", keyIv.subarray(0, 32), keyIv.subarray(32, 48));
    const dump = Buffer.concat([decipher.update(enc.subarray(16)), decipher.final()]);
    const file = path.join(pgdir, "restored.dump");
    fs.writeFileSync(file, dump);
    const toc = execFileSync(`${PGBIN}/pg_restore`, ["--list", file], { encoding: "utf8" });
    expect(toc).toMatch(/TABLE DATA public t postgres/);
  });

  it("a restore check that cannot run is a failed run, with the file kept", async () => {
    await wait(1100);
    const cfg = loadConfig({ ...env, BACKUP_NAME: "unchecked", PG_RESTORE_BIN: "/nonexistent/pg_restore" });
    const r = await runBackup(cfg, { log });
    expect(r.status).toBe("failed");
    expect(r.verified).toBe(false);
    expect(r.error).toMatch(/^Archive not checked: the restore check could not run \(\/nonexistent\/pg_restore: spawn/);
    expect(r.objectKey).toMatch(/^team\/unchecked\//);
    expect((await listBackups(cfg.storage, "unchecked")).map((o) => o.key)).toEqual([r.objectKey]); // probably a fine backup
  });

  it("an archive the restore tool rejects is a failed run, deleted, and retention is skipped", async () => {
    const cfg = loadConfig({ ...env, BACKUP_NAME: "rejected", KEEP_LAST: "2" });
    const goods: string[] = [];
    for (let i = 0; i < 2; i++) {
      await wait(1100);
      const g = await runBackup(cfg, { log });
      expect(g.status, g.error).toBe("success");
      goods.push(g.objectKey!);
    }
    await wait(1100);
    const garbage = path.join(pgdir, "garbage-dump.sh");
    fs.writeFileSync(garbage, "#!/bin/sh\nhead -c 65536 /dev/urandom\nexit 0\n", { mode: 0o755 });
    const r = await runBackup(loadConfig({ ...env, BACKUP_NAME: "rejected", KEEP_LAST: "1", PG_DUMP_BIN: garbage }), { log });
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/^Archive not verified: pg_restore could not read the archive/);
    expect(r.objectKey).toBeUndefined();
    // The rejected file is gone, and KEEP_LAST=1 did not run: both verified backups are still there.
    expect((await listBackups(cfg.storage, "rejected")).map((o) => o.key).sort()).toEqual([...goods].sort());
  });

  it("a checker still reading when the dump stream ends is not killed, and the backup verifies", async () => {
    await wait(1100);
    const slow = path.join(pgdir, "slow-check.sh");
    // Reads the whole archive, then answers after the stream has ended: a busy machine, in slow motion.
    fs.writeFileSync(slow, '#!/bin/sh\ncat >/dev/null\nsleep 0.5\necho "3; 0 0 TABLE public t postgres"\nexit 0\n', { mode: 0o755 });
    const cfg = loadConfig({ ...env, BACKUP_NAME: "slowcheck", PG_RESTORE_BIN: slow });
    const r = await runBackup(cfg, { log });
    expect(r.status, r.error).toBe("success");
    expect(r.verified).toBe(true);
    expect((await listBackups(cfg.storage, "slowcheck")).map((o) => o.key)).toEqual([r.objectKey]);
  });

  it("an empty database is a verified backup", async () => {
    execFileSync(`${PGBIN}/psql`, ["-h", "127.0.0.1", "-p", String(pgPort), "-U", "postgres", "-d", "postgres", "-c", "create database empty_app"]);
    const r = await runBackup(loadConfig({ ...env, DATABASE_URL: `postgresql://postgres@127.0.0.1:${pgPort}/empty_app?sslmode=disable`, BACKUP_NAME: "empty" }), { log });
    expect(r.status, r.error).toBe("success");
    expect(r.verifyNote).toMatch(/database is empty/);
  });

  it("fails cleanly on a bad database and leaves no object behind", async () => {
    const cfg = loadConfig({ ...env, DATABASE_URL: `postgresql://postgres@127.0.0.1:${pgPort}/nope?sslmode=disable`, BACKUP_NAME: "nope" });
    const r = await runBackup(cfg, { log });
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/nope/);
    expect(await listBackups(cfg.storage, "nope")).toEqual([]);
  });

  it("aborts on an external signal and discards the partial upload", async () => {
    const cfg = loadConfig({ ...env, BACKUP_NAME: "aborted" });
    const ac = new AbortController();
    ac.abort();
    const r = await runBackup(cfg, { log, signal: ac.signal });
    expect(r.status).toBe("failed");
    expect(r.error).toBe("shutting down");
    expect(await listBackups(cfg.storage, "aborted")).toEqual([]);
  });
});
