const ORDER = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRET_KEY =
  /(key|token|secret|password|authorization|cookie|credential)/i;

let minLevel = process.env.LOG_LEVEL in ORDER ? process.env.LOG_LEVEL : "info";

export function setLogLevel(level) {
  minLevel = level;
}

/** Removes credentials from structured log metadata before it is written. */
function sanitize(value, depth = 0) {
  if (depth > 4) return "[depth]";
  if (value instanceof Error) {
    const code = value.code;
    return {
      name: value.name,
      message: value.message,
      ...(code ? { code } : {}),
    };
  }
  if (Array.isArray(value))
    return value.slice(0, 20).map((v) => sanitize(v, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        SECRET_KEY.test(k) ? "[redacted]" : sanitize(v, depth + 1),
      ]),
    );
  }
  if (typeof value === "string" && value.length > 2000)
    return `${value.slice(0, 2000)}…`;
  return value;
}

function write(level, message, meta) {
  if (ORDER[level] < ORDER[minLevel] || process.env.NODE_ENV === "test") return;
  const line = JSON.stringify({
    time: new Date().toISOString(),
    level,
    message,
    ...(meta ? sanitize(meta) : {}),
  });
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

export const logger = {
  debug: (message, meta) => write("debug", message, meta),
  info: (message, meta) => write("info", message, meta),
  warn: (message, meta) => write("warn", message, meta),
  error: (message, meta) => write("error", message, meta),
};
