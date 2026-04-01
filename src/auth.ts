import type { IncomingMessage } from "http";
import { createHash, createHmac, timingSafeEqual } from "crypto";
import { config } from "./config.js";

// ── Types ─────────────────────────────────────────

export type AuthResult = { valid: false } | ValidAuth;

export type ValidAuth = {
  valid: true;
  userId: number;
  firstName?: string | undefined;
  lastName?: string | undefined;
  username?: string | undefined;
};

// ── Helpers ───────────────────────────────────────

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// ── Mini App Init Data (HMAC-SHA256 with bot token) ──

function validateInitData(initData: string): AuthResult {
  if (!initData) return { valid: false };

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return { valid: false };

  params.delete("hash");
  const entries = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
  const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join("\n");

  const secretKey = createHmac("sha256", "WebAppData").update(config.TELEGRAM_BOT_TOKEN).digest();
  const computedHash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  if (!safeCompare(computedHash, hash)) return { valid: false };

  try {
    const user = JSON.parse(params.get("user") ?? "{}") as {
      id?: number;
      first_name?: string;
      last_name?: string;
      username?: string;
    };
    if (user.id == null) return { valid: false };
    return {
      valid: true,
      userId: user.id,
      firstName: user.first_name,
      lastName: user.last_name,
      username: user.username,
    };
  } catch {
    return { valid: false };
  }
}

// ── Login Widget (30-day expiry) ─────────────────

function validateLoginWidget(data: string): AuthResult {
  if (!data) return { valid: false };

  try {
    const parsed = JSON.parse(data) as Record<string, unknown>;
    const { hash, ...rest } = parsed;
    if (typeof hash !== "string") return { valid: false };

    const authDate = Number(rest["auth_date"]);
    if (isNaN(authDate) || Date.now() / 1000 - authDate > 30 * 86400) {
      return { valid: false };
    }

    const entries = Object.entries(rest).sort(([a], [b]) => a.localeCompare(b));
    const dataCheckString = entries.map(([k, v]) => `${k}=${String(v)}`).join("\n");

    const secretKey = createHash("sha256").update(config.TELEGRAM_BOT_TOKEN).digest();
    const computedHash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

    if (!safeCompare(computedHash, hash)) return { valid: false };

    const userId = Number(parsed["id"]);
    if (isNaN(userId)) return { valid: false };
    return {
      valid: true,
      userId,
      firstName: parsed["first_name"] as string | undefined,
      lastName: parsed["last_name"] as string | undefined,
      username: parsed["username"] as string | undefined,
    };
  } catch {
    return { valid: false };
  }
}

// ── Dual Auth Entry Point ────────────────────────

export function authenticate(req: IncomingMessage): AuthResult {
  const initData = req.headers["x-telegram-init-data"] as string | undefined;
  if (initData) return validateInitData(initData);

  const loginData = req.headers["x-telegram-login-data"] as string | undefined;
  if (loginData) return validateLoginWidget(loginData);

  return { valid: false };
}
