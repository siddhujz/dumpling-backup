/** Plain timestamped lines on stdout; container platforms collect them as they are. */
export function log(msg: string) {
  process.stdout.write(`${new Date().toISOString()} ${msg}\n`);
}

export function warn(msg: string) {
  process.stderr.write(`${new Date().toISOString()} WARN ${msg}\n`);
}
