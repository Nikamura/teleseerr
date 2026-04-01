import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { config } from "./config.js";
import { log } from "./logger.js";
import type { AccountLink, PendingUser } from "./types.js";

// ── Account Link Store (JSON file) ────────────────

const linksPath = join(config.DATA_DIR, "links.json");
let links = new Map<number, AccountLink>();

function ensureDataDir() {
  if (!existsSync(config.DATA_DIR)) {
    mkdirSync(config.DATA_DIR, { recursive: true });
  }
}

function loadLinks(): void {
  ensureDataDir();
  if (existsSync(linksPath)) {
    try {
      const raw = readFileSync(linksPath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, AccountLink & { sessionCookie?: string }>;
      // Migration: strip sessionCookie from old entries
      for (const [key, entry] of Object.entries(parsed)) {
        delete entry.sessionCookie;
        links.set(Number(key), entry);
      }
    } catch {
      log.warn("Failed to load links file, starting fresh");
      links = new Map();
    }
  }
}

function saveLinks(): void {
  ensureDataDir();
  writeFileSync(linksPath, JSON.stringify(Object.fromEntries(links), null, 2));
}

// Load on startup
loadLinks();

export const accountStore = {
  get(telegramUserId: number): AccountLink | undefined {
    return links.get(telegramUserId);
  },

  getAll(): AccountLink[] {
    return [...links.values()];
  },

  set(link: AccountLink): void {
    links.set(link.telegramUserId, link);
    saveLinks();
    log.info(
      { telegramUser: link.telegramUserId, seerrUser: link.seerrUsername },
      "account linked",
    );
  },

  delete(telegramUserId: number): void {
    links.delete(telegramUserId);
    saveLinks();
    log.info({ telegramUser: telegramUserId }, "account unlinked");
  },
};

// ── Pending Users Store (JSON file) ──────────────

const pendingPath = join(config.DATA_DIR, "pending.json");
const ignoredPath = join(config.DATA_DIR, "ignored.json");
let pending = new Map<number, PendingUser>();
let ignored = new Set<number>();

function loadPending(): void {
  ensureDataDir();
  if (existsSync(pendingPath)) {
    try {
      const parsed = JSON.parse(readFileSync(pendingPath, "utf-8")) as Record<string, PendingUser>;
      pending = new Map(Object.entries(parsed).map(([k, v]) => [Number(k), v]));
    } catch {
      pending = new Map();
    }
  }
  if (existsSync(ignoredPath)) {
    try {
      ignored = new Set(JSON.parse(readFileSync(ignoredPath, "utf-8")) as number[]);
    } catch {
      ignored = new Set();
    }
  }
}

function savePending(): void {
  ensureDataDir();
  writeFileSync(pendingPath, JSON.stringify(Object.fromEntries(pending), null, 2));
}

function saveIgnored(): void {
  ensureDataDir();
  writeFileSync(ignoredPath, JSON.stringify([...ignored]));
}

loadPending();

export const pendingStore = {
  get(telegramUserId: number): PendingUser | undefined {
    return pending.get(telegramUserId);
  },

  getAll(): PendingUser[] {
    return [...pending.values()];
  },

  add(user: PendingUser): boolean {
    if (pending.has(user.telegramUserId)) return false;
    if (ignored.has(user.telegramUserId)) return false;
    pending.set(user.telegramUserId, user);
    savePending();
    log.info({ telegramUser: user.telegramUserId }, "pending link request added");
    return true;
  },

  remove(telegramUserId: number): void {
    pending.delete(telegramUserId);
    savePending();
  },

  ignore(telegramUserId: number): void {
    pending.delete(telegramUserId);
    ignored.add(telegramUserId);
    savePending();
    saveIgnored();
    log.info({ telegramUser: telegramUserId }, "pending link request ignored");
  },

  unignore(telegramUserId: number): void {
    ignored.delete(telegramUserId);
    saveIgnored();
    log.info({ telegramUser: telegramUserId }, "user unignored");
  },

  getIgnored(): number[] {
    return [...ignored];
  },
};

// ── Rate Limiters ─────────────────────────────────

const searchLimiter = new Map<number, number>();
const requestLimiter = new Map<number, number>();

export function canSearch(userId: number): boolean {
  const now = Date.now();
  const last = searchLimiter.get(userId) ?? 0;
  if (now - last < 500) return false;
  searchLimiter.set(userId, now);
  return true;
}

export function canRequest(userId: number): boolean {
  const now = Date.now();
  const last = requestLimiter.get(userId) ?? 0;
  if (now - last < 2000) return false;
  requestLimiter.set(userId, now);
  return true;
}

// Cleanup stale limiter entries every 60s
setInterval(() => {
  const cutoff = Date.now() - 60_000;
  for (const [id, ts] of searchLimiter) {
    if (ts < cutoff) searchLimiter.delete(id);
  }
  for (const [id, ts] of requestLimiter) {
    if (ts < cutoff) requestLimiter.delete(id);
  }
}, 60_000);
