import pino from "pino";
import { getConfig } from "../shared/config.js";

let logger: pino.Logger | null = null;

export function getLogger(): pino.Logger {
  if (logger) return logger;

  const config = getConfig();

  logger = pino({
    level: config.logLevel,
    transport:
      config.nodeEnv === "development"
        ? { target: "pino/file", options: { destination: 1 } }
        : undefined,
    base: { service: "linkedin-job-scraper" },
    timestamp: pino.stdTimeFunctions.isoTime,
  });

  return logger;
}

export function createChildLogger(bindings: Record<string, unknown>): pino.Logger {
  return getLogger().child(bindings);
}
