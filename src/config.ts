import "dotenv/config";
import { serviceUrl } from "./transport.js";

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function optional(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function requiredInt(key: string): number {
  const val = Number(required(key));
  if (isNaN(val)) throw new Error(`${key} must be a number`);
  return val;
}

function optionalInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const val = Number(raw);
  if (isNaN(val)) throw new Error(`${key} must be a number, got "${raw}"`);
  return val;
}

function retryDelays(): number[] {
  const values = (process.env["TELESEERR_RETRY_DELAYS_SECONDS"] ?? "30,120,300")
    .split(",")
    .map(Number);
  if (
    values.length < 1 ||
    values.length > 10 ||
    values.some((value) => !Number.isSafeInteger(value) || value < 1 || value > 86400)
  ) {
    throw new Error(
      "TELESEERR_RETRY_DELAYS_SECONDS requires 1–10 integer delays between 1 and 86400 seconds",
    );
  }
  return values;
}

const allowHttp = optional("TELESEERR_ALLOW_INSECURE_HTTP", "false") === "true";
function optionalServiceUrl(key: string): string {
  const value = optional(key, "");
  return value ? serviceUrl(value, key, allowHttp) : "";
}

export const config = {
  TELEGRAM_BOT_TOKEN: required("TELEGRAM_BOT_TOKEN"),
  SEERR_URL: serviceUrl(required("SEERR_URL"), "SEERR_URL", allowHttp),
  ALLOW_INSECURE_HTTP: allowHttp,
  SEERR_API_KEY: required("SEERR_API_KEY"),
  ADMIN_USER_ID: requiredInt("TELESEERR_ADMIN_USER_ID"),
  ADMIN_SEERR_USER_ID: optionalInt("TELESEERR_ADMIN_SEERR_USER_ID", 1),

  TMDB_IMAGE_BASE: optional("TMDB_IMAGE_BASE", "https://image.tmdb.org/t/p"),

  DEFAULT_4K: optional("TELESEERR_DEFAULT_4K", "false") === "true",
  DATA_DIR: optional("TELESEERR_DATA_DIR", "./data"),
  LOG_LEVEL: optional("LOG_LEVEL", "info"),
  WEBHOOK_SECRET: optional("TELESEERR_WEBHOOK_SECRET", ""),
  MINI_APP_PORT: optionalInt("TELESEERR_MINI_APP_PORT", 3000),
  MINI_APP_URL: optional("TELESEERR_MINI_APP_URL", ""),
  AUTO_RETRY_FAILED: optional("TELESEERR_AUTO_RETRY_FAILED", "false") === "true",
  RETRY_DELAYS_SECONDS: retryDelays(),
  ANIME_SONARR_ID: optional("TELESEERR_ANIME_SONARR_ID", ""),

  // Sonarr/Radarr direct API (optional — for download progress)
  RADARR_URL: optionalServiceUrl("TELESEERR_RADARR_URL"),
  RADARR_API_KEY: optional("TELESEERR_RADARR_API_KEY", ""),
  SONARR_URL: optionalServiceUrl("TELESEERR_SONARR_URL"),
  SONARR_API_KEY: optional("TELESEERR_SONARR_API_KEY", ""),
  RADARR_4K_URL: optionalServiceUrl("TELESEERR_RADARR_4K_URL"),
  RADARR_4K_API_KEY: optional("TELESEERR_RADARR_4K_API_KEY", ""),
  SONARR_4K_URL: optionalServiceUrl("TELESEERR_SONARR_4K_URL"),
  SONARR_4K_API_KEY: optional("TELESEERR_SONARR_4K_API_KEY", ""),
} as const;
