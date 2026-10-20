import { Cron } from "croner";
import { runBackup, type RunOutcome } from "./backup";
import { ConfigError, describeDatabase, loadConfig, type Config } from "./config";
import { detectMysqldumpFlavour } from "./dump";
import { log, warn } from "./log";
import { notify } from "./notify";
import { writeStatus } from "./status";

const VERSION = "0.1.3";

function main() {
  let cfg: Config;
  try {
    cfg = loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`${e.message}\nSee https://github.com/siddhujz/dumpling-backup#configuration\n`);
      process.exit(2);
    }
    throw e;
  }

  log(`dumpling-backup ${VERSION}: ${describeDatabase(cfg.database)} -> s3://${cfg.storage.bucket}/${[cfg.storage.prefix, cfg.backupName].filter(Boolean).join("/")}/`);
  log(`Retention: ${cfg.keepLast ? `keep last ${cfg.keepLast}` : "no count limit"}, ${cfg.keepDays ? `keep ${cfg.keepDays} days` : "no age limit"}${cfg.passphrase ? "; encryption on" : ""}${cfg.webhookUrl ? "; webhook on" : ""}${cfg.healthcheckUrl ? "; healthcheck ping on" : ""}`);
  if (cfg.database.engine === "mysql") log(`mysqldump flavour: ${detectMysqldumpFlavour(cfg.mysqldumpBin)}`);
  log("Backup history, missed-run alerts and test restores without running a container: https://getdumpling.dev/r/container");

  // inFlight covers the whole run including the notification, so a shutdown never cuts a webhook off.
  let inFlight: AbortController | null = null;
  let stopping = false;
  let nextRunAt: string | null = null;
  let lastOutcome: RunOutcome | undefined;
  let lastRunAt: string | null = null;
  let statusWarned = false;
  const setStatus = (state: "starting" | "idle" | "running") => {
    try {
      writeStatus(cfg.statusFile, { state, lastStatus: lastOutcome?.status ?? null, lastRunAt, lastError: lastOutcome?.error ?? null, lastVerified: lastOutcome?.verified ?? null, nextRunAt });
    } catch (e) {
      // A read-only filesystem without a writable /tmp must not take the backups down with it.
      if (!statusWarned) warn(`cannot write ${cfg.statusFile} (${(e as Error).message}); the Docker healthcheck will report unhealthy`);
      statusWarned = true;
    }
  };

  const runOnce = async (): Promise<RunOutcome> => {
    if (inFlight) {
      log("Skipping: the previous backup is still running");
      return lastOutcome ?? { status: "failed", error: "skipped", durationMs: 0 };
    }
    inFlight = new AbortController();
    setStatus("running");
    const outcome = await runBackup(cfg, { signal: inFlight.signal, log });
    lastOutcome = outcome;
    lastRunAt = new Date().toISOString();
    if (outcome.status === "success") {
      log(`OK ${cfg.backupName}: ${outcome.sizeBytes} bytes, verified (${outcome.verifyNote}), ${outcome.durationMs} ms${outcome.warning ? `. ${outcome.warning}` : ""}`);
    } else {
      warn(`FAILED ${cfg.backupName}: ${outcome.error}`);
    }
    setStatus("idle");
    await notify(cfg, outcome, warn);
    inFlight = null;
    if (stopping) process.exit(outcome.status === "success" ? 0 : 1);
    return outcome;
  };

  const shutdown = (sig: string) => {
    if (stopping) return;
    stopping = true;
    if (inFlight) {
      log(`${sig}: aborting the backup in progress (the partial upload is discarded)`);
      inFlight.abort();
      setTimeout(() => process.exit(1), 15_000).unref(); // only if the abort itself hangs
    } else {
      log(`${sig}: exiting`);
      process.exit(0);
    }
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  if (cfg.schedule === "once") {
    setStatus("starting");
    runOnce().then((o) => process.exit(o.status === "success" ? 0 : 1));
    return;
  }

  let job: Cron;
  try {
    job = new Cron(cfg.schedule, { timezone: cfg.cronTimezone, protect: true }, async () => {
      await runOnce();
      nextRunAt = job.nextRun()?.toISOString() ?? null;
      if (!inFlight) setStatus("idle");
    });
  } catch (e) {
    process.stderr.write(`${cfg.cronTimezone ? "SCHEDULE or CRON_TZ is invalid" : "SCHEDULE is not a valid cron expression"}: ${(e as Error).message}\n`);
    process.exit(2);
  }
  nextRunAt = job.nextRun()?.toISOString() ?? null;
  log(`Schedule: ${cfg.schedule}${cfg.cronTimezone ? ` (${cfg.cronTimezone})` : " (UTC)"}; next run ${nextRunAt ?? "never"}`);
  setStatus("starting");
  if (cfg.runOnStart) {
    runOnce().then(() => {
      if (!inFlight) setStatus("idle");
    });
  } else {
    setStatus("idle");
  }
}

main();
