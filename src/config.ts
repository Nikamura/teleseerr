import "dotenv/config";

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function optional(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

export const config = {
  TELEGRAM_BOT_TOKEN: required("TELEGRAM_BOT_TOKEN"),
  SEERR_URL: required("SEERR_URL").replace(/\/$/, ""),
  SEERR_API_KEY: required("SEERR_API_KEY"),
  ADMIN_USER_ID: Number(required("TELESEERR_ADMIN_USER_ID")),
  ADMIN_SEERR_USER_ID: Number(optional("TELESEERR_ADMIN_SEERR_USER_ID", "1")),

  TMDB_IMAGE_BASE: optional("TMDB_IMAGE_BASE", "https://image.tmdb.org/t/p"),

  DEFAULT_4K: optional("TELESEERR_DEFAULT_4K", "false") === "true",
  DATA_DIR: optional("TELESEERR_DATA_DIR", "./data"),
  LOG_LEVEL: optional("LOG_LEVEL", "info"),
  WEBHOOK_SECRET: optional("TELESEERR_WEBHOOK_SECRET", ""),
  MINI_APP_PORT: Number(optional("TELESEERR_MINI_APP_PORT", "3000")),
  MINI_APP_URL: optional("TELESEERR_MINI_APP_URL", ""),
  ANIME_SONARR_ID: optional("TELESEERR_ANIME_SONARR_ID", ""),
} as const;

if (isNaN(config.ADMIN_USER_ID)) {
  throw new Error("TELESEERR_ADMIN_USER_ID must be a number");
}
