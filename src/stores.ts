import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { config } from "./config.js";
import { log } from "./logger.js";
import type { AccountLink, PendingUser } from "./types.js";

// ── Account Link Store (JSON file) ────────────────

const linksPath = join(config.DATA_DIR, "links.json");
let links: Record<number, AccountLink> = {};

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
      const parsed = JSON.parse(raw);
      // Migration: strip sessionCookie from old entries
      for (const key of Object.keys(parsed)) {
        delete parsed[key].sessionCookie;
      }
      links = parsed;
    } catch (e) {
      log.warn("Failed to load links file, starting fresh");
      links = {};
    }
  }
}

function saveLinks(): void {
  ensureDataDir();
  writeFileSync(linksPath, JSON.stringify(links, null, 2));
}

// Load on startup
loadLinks();

export const accountStore = {
  get(telegramUserId: number): AccountLink | undefined {
    return links[telegramUserId];
  },

  getAll(): AccountLink[] {
    return Object.values(links);
  },

  set(link: AccountLink): void {
    links[link.telegramUserId] = link;
    saveLinks();
    log.info({ telegramUser: link.telegramUserId, seerrUser: link.seerrUsername }, "account linked");
  },

  delete(telegramUserId: number): void {
    delete links[telegramUserId];
    saveLinks();
    log.info({ telegramUser: telegramUserId }, "account unlinked");
  },
};

// ── Pending Users Store (JSON file) ──────────────

const pendingPath = join(config.DATA_DIR, "pending.json");
const ignoredPath = join(config.DATA_DIR, "ignored.json");
let pending: Record<number, PendingUser> = {};
let ignored = new Set<number>();

function loadPending(): void {
  ensureDataDir();
  if (existsSync(pendingPath)) {
    try {
      pending = JSON.parse(readFileSync(pendingPath, "utf-8"));
    } catch {
      pending = {};
    }
  }
  if (existsSync(ignoredPath)) {
    try {
      ignored = new Set(JSON.parse(readFileSync(ignoredPath, "utf-8")));
    } catch {
      ignored = new Set();
    }
  }
}

function savePending(): void {
  ensureDataDir();
  writeFileSync(pendingPath, JSON.stringify(pending, null, 2));
}

function saveIgnored(): void {
  ensureDataDir();
  writeFileSync(ignoredPath, JSON.stringify([...ignored]));
}

loadPending();

export const pendingStore = {
  get(telegramUserId: number): PendingUser | undefined {
    return pending[telegramUserId];
  },

  getAll(): PendingUser[] {
    return Object.values(pending);
  },

  add(user: PendingUser): boolean {
    if (pending[user.telegramUserId]) return false;
    if (ignored.has(user.telegramUserId)) return false;
    pending[user.telegramUserId] = user;
    savePending();
    log.info({ telegramUser: user.telegramUserId }, "pending link request added");
    return true;
  },

  remove(telegramUserId: number): void {
    delete pending[telegramUserId];
    savePending();
  },

  ignore(telegramUserId: number): void {
    delete pending[telegramUserId];
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
