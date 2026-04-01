import pino from "pino";
import { config } from "./config.js";

export const log = pino({
  level: config.LOG_LEVEL,
  ...(process.env["NODE_ENV"] !== "production" && {
    transport: { target: "pino-pretty", options: { colorize: true } },
  }),
});
