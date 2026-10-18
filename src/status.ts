import fs from "node:fs";
import path from "node:path";

/** What the container healthcheck reads. Never contains credentials, keys or URLs. */
export interface Status {
  state: "starting" | "idle" | "running";
  lastStatus: "success" | "failed" | null;
  lastRunAt: string | null;
  lastError: string | null;
  lastVerified: boolean | null;
  nextRunAt: string | null;
  updatedAt: string;
}

export function writeStatus(file: string, status: Omit<Status, "updatedAt">) {
  const full: Status = { ...status, updatedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(full));
  fs.renameSync(tmp, file);
}

export function readStatus(file: string): Status | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Status;
  } catch {
    return null;
  }
}

/**
 * Unhealthy when: no status file (the process never started), the last run failed, or the next run
 * is more than an hour overdue (the scheduler is wedged). A run in flight is healthy.
 */
export function evaluateHealth(status: Status | null, now = Date.now()): { healthy: boolean; reason: string } {
  if (!status) return { healthy: false, reason: "no status file; the process has not started" };
  if (status.lastStatus === "failed") return { healthy: false, reason: `last backup failed: ${status.lastError ?? "unknown error"}` };
  if (status.state !== "running" && status.nextRunAt && new Date(status.nextRunAt).getTime() < now - 3600_000) return { healthy: false, reason: `next run was due at ${status.nextRunAt} and has not started` };
  return { healthy: true, reason: status.lastRunAt ? `last backup ${status.lastStatus} at ${status.lastRunAt}` : "no backup has run yet" };
}
