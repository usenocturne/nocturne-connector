import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "fs";
import { join } from "path";
import { CONNECTOR_STATE_DIR } from "../config";

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type LogLevel = keyof typeof LOG_LEVELS;
const LOG_FILE_MAX_BYTES = 5 * 1024 * 1024;
const logFile =
  process.platform === "win32"
    ? join(CONNECTOR_STATE_DIR, "logs", "connector.log")
    : null;

const currentLevel: LogLevel =
  (process.env.LOG_LEVEL as LogLevel) || "info";

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
}

function timestamp(): string {
  return new Date().toISOString();
}

function writeRotatingLog(line: string): void {
  if (!logFile) return;
  try {
    const directory = join(CONNECTOR_STATE_DIR, "logs");
    if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
    if (existsSync(logFile) && statSync(logFile).size >= LOG_FILE_MAX_BYTES) {
      for (let index = 3; index >= 1; index--) {
        const source = `${logFile}.${index}`;
        const destination = `${logFile}.${index + 1}`;
        if (existsSync(source)) renameSync(source, destination);
      }
      renameSync(logFile, `${logFile}.1`);
    }
    appendFileSync(logFile, `${line}\n`, { encoding: "utf8" });
  } catch {
    // Logging must never interrupt the connector.
  }
}

function formatLine(level: LogLevel, category: string, msg: string, args: unknown[]): string {
  const suffix = args.length
    ? ` ${args.map((arg) => {
        try {
          return typeof arg === "string" ? arg : JSON.stringify(arg);
        } catch {
          return String(arg);
        }
      }).join(" ")}`
    : "";
  return `[${timestamp()}] [${level.toUpperCase()}] [${category}] ${msg}${suffix}`;
}

export function createLogger(category: string) {
  return {
    debug(msg: string, ...args: unknown[]) {
      if (shouldLog("debug")) {
        const line = formatLine("debug", category, msg, args);
        console.debug(`[${timestamp()}] [DEBUG] [${category}] ${msg}`, ...args);
        writeRotatingLog(line);
      }
    },
    info(msg: string, ...args: unknown[]) {
      if (shouldLog("info")) {
        const line = formatLine("info", category, msg, args);
        console.info(`[${timestamp()}] [INFO] [${category}] ${msg}`, ...args);
        writeRotatingLog(line);
      }
    },
    warn(msg: string, ...args: unknown[]) {
      if (shouldLog("warn")) {
        const line = formatLine("warn", category, msg, args);
        console.warn(`[${timestamp()}] [WARN] [${category}] ${msg}`, ...args);
        writeRotatingLog(line);
      }
    },
    error(msg: string, ...args: unknown[]) {
      if (shouldLog("error")) {
        const line = formatLine("error", category, msg, args);
        console.error(`[${timestamp()}] [ERROR] [${category}] ${msg}`, ...args);
        writeRotatingLog(line);
      }
    },
  };
}
