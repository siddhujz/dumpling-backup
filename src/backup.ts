import { spawn } from "node:child_process";
import { PassThrough, Readable, Transform, pipeline as pipelineCb } from "node:stream";
import { createGzip } from "node:zlib";
import type { Config } from "./config";
import { createOpenSslEncryptStream } from "./encrypt";
import { buildDumpCommand, childEnv, isRoutinePrivilegeError, isServerVersionMismatch } from "./dump";
import { backupFileName, retainableBackups, staleKeys } from "./retention";
import { deleteKeys, describeS3Error, joinKey, listBackups, uploadStream } from "./s3";
import { createDumpVerifier } from "./verify";

export interface RunOutcome {
  status: "success" | "failed";
  objectKey?: string;
  sizeBytes?: number;
  durationMs: number;
  error?: string;
  verified?: boolean;
  verifyNote?: string;
  /** Set when the run succeeded with a caveat (e.g. routines skipped). */
  warning?: string;
}

function describeMs(ms: number) {
  return ms >= 3600_000 ? `${Math.round(ms / 3600_000)} hours` : ms >= 60_000 ? `${Math.round(ms / 60_000)} minutes` : `${Math.round(ms / 1000)} seconds`;
}

export interface RunOptions {
  /** External abort (shutdown). */
  signal?: AbortSignal;
  routines?: boolean;
  log?: (line: string) => void;
}

/**
 * One backup: dump -> exit gate -> verifier tap -> (gzip for mysql) -> (encrypt) -> multipart
 * upload, then retention. Nothing touches local disk. Any limit (stall, wall clock, size cap,
 * shutdown) kills the dump and aborts the upload so a partial file is never completed.
 */
export async function runBackup(cfg: Config, opts: RunOptions = {}): Promise<RunOutcome> {
  const log = opts.log ?? (() => {});
  const d = cfg.database;
  const started = Date.now();
  const fail = (error: string): RunOutcome => ({ status: "failed", error: error.slice(0, 500), durationMs: Date.now() - started });

  const fileName = backupFileName(d.engine, !!cfg.passphrase);
  const key = joinKey(cfg.storage.prefix, cfg.backupName, fileName);
  const { cmd, args, envVars } = buildDumpCommand(cfg, d, { routines: opts.routines });
  log(`Running ${cmd} for ${d.engine} ${d.host}:${d.port}/${d.dbName} -> s3://${cfg.storage.bucket}/${key}`);

  const child = spawn(cmd, args, { env: envVars, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (c) => {
    stderr += c.toString();
    if (stderr.length > 2000) stderr = stderr.slice(-2000);
  });
  const exit = new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? -1));
  });

  const uploadAbort = new AbortController();
  let abortReason: string | null = null;
  const abort = (reason: string) => {
    if (abortReason) return;
    abortReason = reason;
    child.kill("SIGKILL");
    uploadAbort.abort();
  };
  const onExternalAbort = () => abort("shutting down");
  if (opts.signal?.aborted) onExternalAbort();
  opts.signal?.addEventListener("abort", onExternalAbort, { once: true });

  let bytes = 0;
  let lastData = Date.now(); // raw dump output; measured before gzip so a slow, compressible stream is not mistaken for a stall
  const limit = cfg.maxDumpBytes ? cfg.maxDumpBytes * 2 : 0; // dumps are usually smaller than the DB; allow slack
  const counter = new PassThrough();
  counter.on("data", (c: Buffer) => {
    bytes += c.length;
    if (limit && bytes > limit) abort(`Dump exceeded ${Math.round(limit / 1024 ** 3)} GB (2x MAX_DUMP_GB)`);
  });
  const stallTimer = setInterval(() => {
    if (Date.now() - lastData > cfg.stallMs) abort(`No data from the dump for ${describeMs(cfg.stallMs)} (the database stopped responding)`);
  }, Math.min(30_000, cfg.stallMs));
  const wallTimer = cfg.maxRunMs ? setTimeout(() => abort(`Run exceeded MAX_RUN_MINUTES (${describeMs(cfg.maxRunMs)})`), cfg.maxRunMs) : null;

  // The dump's stdout ends normally even when the tool died mid-way; this gate makes the stream
  // fail unless the exit code was 0, so a truncated dump is never finalised as a valid object.
  const exitGate = new Transform({
    transform(chunk, _enc, cb) {
      lastData = Date.now();
      cb(null, chunk);
    },
    flush(cb) {
      exit.then((code) => cb(code === 0 ? null : new Error(`${cmd} exited with code ${code}: ${stderr.trim() || "(no stderr)"}`)), cb);
    },
  });

  // Restore verification taps the raw dump before compression and encryption.
  const verifier = createDumpVerifier(d.engine, cfg.pgRestoreBin, childEnv({}));
  const stages: NodeJS.ReadWriteStream[] = [exitGate, verifier.tap];
  if (d.engine === "mysql") stages.push(createGzip({ level: 6 }));
  if (cfg.passphrase) stages.push(createOpenSslEncryptStream(cfg.passphrase));
  stages.push(counter);

  const out = new PassThrough();
  const pipelineDone = new Promise<void>((resolve, reject) => {
    pipelineCb(child.stdout as Readable, ...(stages as [NodeJS.ReadWriteStream]), out, (err) => (err ? reject(err) : resolve()));
  });

  const cleanup = () => {
    clearInterval(stallTimer);
    if (wallTimer) clearTimeout(wallTimer);
    opts.signal?.removeEventListener("abort", onExternalAbort);
  };

  let verification: { verified: boolean; note: string } | undefined;
  let uploadP: Promise<void> | undefined;
  try {
    uploadP = uploadStream(cfg.storage, key, out, { abortController: uploadAbort, maxBytes: limit });
    const [code] = await Promise.all([exit, pipelineDone, uploadP]);
    if (code !== 0) throw new Error(`${cmd} exited with code ${code}: ${stderr.trim() || "(no stderr)"}`);
    if (bytes === 0) throw new Error("Dump produced 0 bytes");
    log(`Uploaded ${bytes} bytes in ${Date.now() - started} ms`);
    verification = await Promise.race([verifier.result, new Promise<{ verified: boolean; note: string }>((r) => setTimeout(() => r({ verified: false, note: "verification timed out" }), 60_000).unref())]);
    if (verification.note === "verification timed out") verifier.cancel();
    log(`${verification.verified ? "Verified" : "Not verified"}: ${verification.note}`);
  } catch (e) {
    child.kill("SIGKILL");
    verifier.cancel();
    clearInterval(stallTimer);
    // The SDK aborts the multipart upload asynchronously after done() rejects; wait for it (bounded) so a
    // one-shot run does not exit before AbortMultipartUpload has gone out.
    if (uploadP) await Promise.race([uploadP.catch(() => {}), new Promise((r) => setTimeout(r, 30_000).unref())]);
    let msg = abortReason ?? ((e as Error).message.includes("$metadata") ? describeS3Error(e) : (e as Error).message);
    if (!abortReason && d.engine === "postgres" && isServerVersionMismatch(stderr)) {
      const versions = /server version: ([\d.]+)[\s\S]*?pg_dump version: ([\d.]+)/.exec(stderr);
      msg = `The PostgreSQL server${versions ? ` (${versions[1]})` : ""} is newer than this image's pg_dump${versions ? ` (${versions[2]})` : ""}. Use the image tag that matches your server's major version.`;
    }
    log(`FAILED: ${msg}`);
    if (stderr.trim()) log(`stderr: ${stderr.trim()}`);
    // Best-effort cleanup of a partial object.
    try {
      await deleteKeys(cfg.storage, [key]);
    } catch {}
    if (!abortReason && d.engine === "mysql" && opts.routines !== false && isRoutinePrivilegeError(stderr)) {
      cleanup();
      log("Backup user cannot read stored routines (MySQL 8 needs SHOW_ROUTINE; older servers SELECT ON mysql.proc). Retrying without --routines; tables, views and triggers are still included.");
      const retried = await runBackup(cfg, { ...opts, routines: false });
      if (retried.status === "success") retried.warning = "Stored procedures and functions were skipped because the backup user lacks SHOW_ROUTINE.";
      return { ...retried, durationMs: Date.now() - started };
    }
    cleanup();
    return fail(msg);
  }

  // An archive the restore tool cannot read is a failed run: exit code, status file and webhook all say so.
  // The object is kept (it may still be partially useful and the user should look at it); retention is
  // skipped so no older, verified backup is deleted to make room for an unverified one.
  if (!verification?.verified) {
    cleanup();
    const note = verification?.note ?? "no verification result";
    log(`FAILED: archive not verified (${note}); the uploaded file was kept at ${key}`);
    return { status: "failed", error: `Archive not verified: ${note}`.slice(0, 500), objectKey: key, sizeBytes: bytes, durationMs: Date.now() - started, verified: false, verifyNote: note };
  }

  // Retention. The wall clock and the abort stay armed: listing and deleting talk to the same endpoint and must be bounded too.
  try {
    if (cfg.keepLast > 0 || cfg.keepDays > 0) {
      // Only ever delete files we wrote for this backup name (timestamp names directly in its folder); anything else is the user's.
      const objects = retainableBackups(await listBackups(cfg.storage, cfg.backupName, uploadAbort.signal), joinKey(cfg.storage.prefix, cfg.backupName));
      const stale = staleKeys(objects, cfg.keepLast, cfg.keepDays);
      if (stale.length) {
        await deleteKeys(cfg.storage, stale, uploadAbort.signal);
        log(`Retention: deleted ${stale.length} old backup(s) (${[cfg.keepLast ? `keep last ${cfg.keepLast}` : "", cfg.keepDays ? `keep ${cfg.keepDays} days` : ""].filter(Boolean).join(", ")})`);
      }
    }
  } catch (e) {
    log(`Retention warning: ${describeS3Error(e)}`);
  } finally {
    cleanup();
  }

  return { status: "success", objectKey: key, sizeBytes: bytes, durationMs: Date.now() - started, verified: verification?.verified, verifyNote: verification?.note };
}
