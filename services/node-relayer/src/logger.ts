/** Minimal structured JSON logger. node-relayer runs unattended as an
 * independent operator process, so every line must be machine-parseable. */

type Fields = Record<string, unknown>;

function line(level: "info" | "warn" | "error", msg: string, fields?: Fields): void {
  const record = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...fields,
  };
  const out = level === "error" ? console.error : console.log;
  out(JSON.stringify(record));
}

export const logger = {
  info: (msg: string, fields?: Fields) => line("info", msg, fields),
  warn: (msg: string, fields?: Fields) => line("warn", msg, fields),
  error: (msg: string, fields?: Fields) => line("error", msg, fields),
};
