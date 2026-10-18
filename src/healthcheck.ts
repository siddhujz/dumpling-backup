import { evaluateHealth, readStatus } from "./status";

const file = process.env.STATUS_FILE || "/tmp/dumpling-backup/status.json";
const h = evaluateHealth(readStatus(file));
process.stdout.write(`${h.healthy ? "healthy" : "unhealthy"}: ${h.reason}\n`);
process.exit(h.healthy ? 0 : 1);
