import pino from "pino";
import { config } from "./config.js";

export const log = pino({
  level: config.LOG_LEVEL,
  transport:
    process.env.NODE_ENV !== "production"
      ? { target: "pino-pretty", options: { colorize: true } }
      : undefined,
});
