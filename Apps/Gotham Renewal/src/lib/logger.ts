/**
 * Structured logging.
 *
 * One JSON object per line on stdout. Vercel, and most log platforms, index
 * that shape automatically; a pretty-printed multi-line object breaks on
 * capture. This is deliberately ~40 lines instead of the pino dependency -
 * when we actually need sampling, transports, or redaction rules, pino earns
 * its place, and swapping this module out is a one-file change.
 *
 * Server-only: logs frequently contain customer contact data and order detail.
 */
import "server-only";

export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Read LOG_LEVEL lazily so that importing the logger never forces a full env parse. */
function threshold(): number {
  const raw = (process.env.LOG_LEVEL ?? "info") as LogLevel;
  return ORDER[raw] ?? ORDER.info;
}

export type LogFields = Record<string, unknown>;

function emit(level: LogLevel, message: string, fields: LogFields = {}): void {
  if (ORDER[level] < threshold()) return;

  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...fields,
  });

  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

/** Serialize an unknown thrown value into loggable fields. */
export function errorFields(error: unknown): LogFields {
  if (error instanceof Error) {
    return {
      error: error.message,
      errorName: error.name,
      stack: error.stack,
    };
  }
  return { error: String(error) };
}

export const logger = {
  debug: (message: string, fields?: LogFields) => emit("debug", message, fields),
  info: (message: string, fields?: LogFields) => emit("info", message, fields),
  warn: (message: string, fields?: LogFields) => emit("warn", message, fields),
  error: (message: string, fields?: LogFields) => emit("error", message, fields),
};
