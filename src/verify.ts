import { spawn } from "node:child_process";
import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";

/**
 * Restore verification during upload, without downloading anything back. A tap on the raw dump
 * stream feeds a checker; the result says whether the file that reached the bucket is an archive
 * the restore tools will accept.
 *  - postgres: `pg_restore --list` must parse the custom-format archive and list its table of contents.
 *  - mysql: the SQL must end with mysqldump's "Dump completed" trailer (a truncated dump has none).
 */
export interface VerifyResult {
  verified: boolean;
  note: string;
}

export interface DumpVerifier {
  tap: Transform;
  result: Promise<VerifyResult>;
  /** Stops the checker (kills pg_restore). Called when the run is aborted or the result is no longer wanted. */
  cancel: () => void;
}

export function createDumpVerifier(engine: string, pgRestoreBin: string, childEnvVars: NodeJS.ProcessEnv): DumpVerifier {
  return engine === "postgres" ? pgVerifier(pgRestoreBin, childEnvVars) : mysqlVerifier();
}

function pgVerifier(bin: string, childEnvVars: NodeJS.ProcessEnv): DumpVerifier {
  const child = spawn(bin, ["--list"], { env: childEnvVars, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.on("data", (c) => {
    if (out.length < 4_000_000) out += c.toString();
  });
  child.stderr.on("data", (c) => {
    if (err.length < 2000) err += c.toString();
  });
  let spawnError = "";
  let stopped = ""; // set when we killed the checker or a signal did: says nothing about the archive
  let dead = false;
  let wake: (() => void) | null = null; // a transform waiting for drain must not wait forever if the checker dies
  const giveUp = () => {
    dead = true;
    wake?.();
  };
  child.stdin.on("error", giveUp); // EPIPE when pg_restore gives up early; the dump itself is unaffected
  child.stdin.on("close", giveUp);
  child.on("exit", giveUp);
  const exit = new Promise<number>((resolve) => {
    child.on("error", (e) => {
      spawnError = `${bin}: ${(e as Error).message}`; // a missing or unusable pg_restore reads as such, not as a bad archive
      resolve(-1);
    });
    child.on("close", (code, signal) => {
      if (signal && !stopped) stopped = `killed by ${signal}`;
      resolve(code ?? -1);
    });
  });
  const cancel = () => {
    dead = true;
    if (child.exitCode === null && child.signalCode === null) stopped = "check stopped before it finished";
    child.kill("SIGKILL");
    wake?.();
  };
  const tap = new Transform({
    transform(chunk, _enc, cb) {
      if (dead || !child.stdin.writable) return cb(null, chunk);
      if (child.stdin.write(chunk)) return cb(null, chunk);
      let done = false;
      const go = () => {
        if (done) return;
        done = true;
        wake = null;
        cb(null, chunk);
      };
      wake = go;
      child.stdin.once("drain", go);
    },
    flush(cb) {
      if (!dead) child.stdin.end();
      cb();
    },
    // A failing pipeline (dump died, abort, S3 error) destroys the tap with an error: the checker must go
    // with it, or a failing run leaks one blocked pg_restore. A clean end also destroys the tap
    // (autoDestroy) while pg_restore may still be reading the last chunk; killing it then reported a
    // valid archive as unreadable. The caller's 60 s timer bounds a checker that never finishes.
    destroy(err, cb) {
      if (err) cancel();
      cb(err);
    },
  });
  const result = exit.then((code) => {
    if (spawnError) return { verified: false, note: spawnError };
    // Same prefix as a spawn error, so the run keeps the file: a stopped check is not a rejected archive.
    if (stopped) return { verified: false, note: `${bin}: ${stopped}` };
    if (code !== 0) return { verified: false, note: `pg_restore could not read the archive${err.trim() ? `: ${err.trim().split("\n")[0].slice(0, 160)}` : ""}` };
    const tables = (out.match(/ TABLE DATA /g) ?? []).length;
    const indexes = (out.match(/ INDEX /g) ?? []).length;
    const entries = out.split("\n").filter((l) => /^\d+;/.test(l)).length;
    // An empty database dumps to a valid archive with no entries; the restore tool accepted it, which is the question.
    if (entries === 0) return { verified: true, note: "database is empty (no tables or other objects)" };
    return { verified: true, note: `${tables} table${tables === 1 ? "" : "s"} with data, ${indexes} index${indexes === 1 ? "" : "es"}, ${entries} entries` };
  });
  return { tap, result, cancel };
}

const MARK = "CREATE TABLE ";

function mysqlVerifier(): DumpVerifier {
  let tail = "";
  let tables = 0;
  // Only the first characters of the current line matter; a single 1 GB INSERT line must cost nothing.
  let linePrefix = "";
  const decoder = new StringDecoder("utf8");
  let resolve!: (r: VerifyResult) => void;
  const result = new Promise<VerifyResult>((r) => (resolve = r));
  const tap = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      const text = decoder.write(chunk);
      let from = 0;
      for (;;) {
        const nl = text.indexOf("\n", from);
        const piece = nl === -1 ? text.slice(from, from + MARK.length) : text.slice(from, Math.min(nl, from + MARK.length));
        if (linePrefix.length < MARK.length) linePrefix += piece.slice(0, MARK.length - linePrefix.length);
        if (nl === -1) break;
        if (linePrefix.startsWith(MARK)) tables++;
        linePrefix = "";
        from = nl + 1;
      }
      tail = (tail + text).slice(-400);
      cb(null, chunk);
    },
    flush(cb) {
      if (linePrefix.startsWith(MARK)) tables++;
      const complete = /-- Dump completed/.test(tail);
      resolve(complete ? { verified: true, note: `${tables} table${tables === 1 ? "" : "s"}, dump trailer present` } : { verified: false, note: "dump has no completion trailer (truncated?)" });
      cb();
    },
  });
  return { tap, result, cancel: () => {} };
}
