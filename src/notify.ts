import http from "node:http";
import https from "node:https";
import type { Config } from "./config";
import type { RunOutcome } from "./backup";

/** One request, no redirects, 10 s hard deadline. Resolves to the HTTP status. */
export function request(url: string, method: "GET" | "POST", body?: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === "http:" ? http : https;
    const data = body === undefined ? undefined : JSON.stringify(body);
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      fn();
    };
    let gotResponse = false;
    const headers: Record<string, string | number> = { "user-agent": "dumpling-backup" };
    if (data !== undefined) {
      headers["content-type"] = "application/json";
      headers["content-length"] = Buffer.byteLength(data);
    }
    const req = mod.request(u, { method, headers }, (res) => {
      gotResponse = true;
      const status = res.statusCode ?? 0;
      res.resume();
      res.on("end", () => finish(() => resolve(status)));
      res.on("close", () => finish(() => resolve(status)));
      res.on("error", (e) => finish(() => reject(e)));
    });
    const deadline = setTimeout(() => req.destroy(new Error("timed out after 10 s")), 10_000);
    req.on("error", (e) => finish(() => reject(e)));
    req.on("close", () => {
      if (!gotResponse) finish(() => reject(new Error("connection closed before a response")));
    });
    req.end(data);
  });
}

/** Slack- and Discord-compatible: `text` and `content` render as a message; the rest is for generic receivers. */
export function webhookPayload(cfg: Pick<Config, "backupName">, outcome: RunOutcome) {
  const ok = outcome.status === "success";
  const summary = ok
    ? `Backup ${cfg.backupName}: ok, ${formatBytes(outcome.sizeBytes ?? 0)}, ${outcome.verified ? "verified" : "not verified"}${outcome.verifyNote ? ` (${outcome.verifyNote})` : ""}${outcome.warning ? `. ${outcome.warning}` : ""}`
    : `Backup ${cfg.backupName} FAILED: ${outcome.error}`;
  return {
    text: summary,
    content: summary,
    event: ok ? "backup.succeeded" : "backup.failed",
    backup: cfg.backupName,
    status: outcome.status,
    sizeBytes: outcome.sizeBytes ?? null,
    objectKey: outcome.objectKey ?? null,
    verified: outcome.verified ?? null,
    verifyNote: outcome.verifyNote ?? null,
    warning: outcome.warning ?? null,
    error: outcome.error ?? null,
    durationMs: outcome.durationMs,
    at: new Date().toISOString(),
  };
}

export async function notify(cfg: Config, outcome: RunOutcome, warn: (s: string) => void) {
  const tasks: Promise<unknown>[] = [];
  if (cfg.webhookUrl && (outcome.status === "failed" || cfg.notifyOnSuccess)) {
    tasks.push(
      request(cfg.webhookUrl, "POST", webhookPayload(cfg, outcome)).then(
        (status) => {
          if (status < 200 || status >= 300) warn(`webhook rejected with HTTP ${status}`);
        },
        (e) => warn(`webhook failed: ${(e as Error).message}`),
      ),
    );
  }
  if (cfg.healthcheckUrl) {
    // healthchecks.io convention: a ping on success, /fail on failure. Other heartbeat services accept the plain ping.
    const u = new URL(cfg.healthcheckUrl);
    if (outcome.status !== "success") u.pathname = `${u.pathname.replace(/\/$/, "")}/fail`; // keeps any query string (hc-ping.com/<uuid>?rid=...)
    const url = u.toString();
    tasks.push(request(url, "GET").catch((e) => warn(`healthcheck ping failed: ${(e as Error).message}`)));
  }
  await Promise.all(tasks);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 2 : 1)} ${units[i]}`;
}
