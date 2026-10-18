/** Matches only files this tool wrote; retention must never touch anything else in the folder. */
export const BACKUP_FILE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.(dump|sql\.gz)(\.enc)?$/;

export interface ListedObject {
  key: string;
  size: number;
  lastModified: Date;
}

export function backupFileName(engine: string, encrypted: boolean, at = new Date()): string {
  const stamp = at.toISOString().replace(/[:.]/g, "-").replace(/-\d{3}Z$/, "Z");
  const ext = engine === "postgres" ? "dump" : "sql.gz";
  return `${stamp}.${ext}${encrypted ? ".enc" : ""}`;
}

/** Objects retention may delete, newest first: directly inside the backup folder (not nested) and named by us. */
export function retainableBackups(objects: ListedObject[], folderPrefix: string): ListedObject[] {
  const prefix = folderPrefix.endsWith("/") ? folderPrefix : `${folderPrefix}/`;
  return objects
    .filter((o) => o.key.startsWith(prefix))
    .filter((o) => {
      const rest = o.key.slice(prefix.length);
      return !rest.includes("/") && BACKUP_FILE_RE.test(rest);
    })
    .sort((a, b) => (a.key < b.key ? 1 : -1)); // ISO stamps sort; newest first
}

/**
 * Keys to delete: beyond keepLast (0 = no count limit) or older than keepDays (0 = no age limit);
 * both rules apply when both are set. Bounded per run so a huge folder drains over several runs.
 */
export function staleKeys(retainable: ListedObject[], keepLast: number, keepDays = 0, now = Date.now(), batch = 500): string[] {
  const byCount = keepLast > 0 ? retainable.slice(keepLast) : [];
  const byAge = keepDays > 0 ? retainable.filter((o) => o.lastModified.getTime() < now - keepDays * 86400_000) : [];
  const keys = new Set([...byCount, ...byAge].map((o) => o.key));
  return retainable.filter((o) => keys.has(o.key)).slice(0, batch).map((o) => o.key);
}
