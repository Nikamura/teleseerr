import { InlineKeyboard, type Bot } from "grammy";
import { json, error, parseJsonBody, pageParam, type RouteContext } from "../http.js";
import { accountStore, pendingStore } from "../stores.js";
import * as seerr from "../seerr/client.js";
import { config } from "../config.js";
import { log } from "../logger.js";
import type { AccountLink } from "../types.js";

// ── Bot Instance (set by server.ts on startup) ───

let botInstance: Bot | null = null;
const profileLookupAttempts = new Map<number, number>();

export function setAdminBotInstance(bot: Bot): void {
  botInstance = bot;
}

// ── Admin Route Handlers ─────────────────────────

export function handleAdminPending({ res }: RouteContext): void {
  json(res, pendingStore.getAll());
}

export function handleAdminUsers({ res }: RouteContext): void {
  json(res, accountStore.getAll());
}

export async function handleAdminSeerrUsers({ res, url }: RouteContext): Promise<void> {
  const page = pageParam(url);
  json(res, await seerr.getUsers({ take: 20, skip: (page - 1) * 20 }));
}

export async function handleAdminLink({ req, res }: RouteContext): Promise<void> {
  const body = await parseJsonBody(req);
  if (typeof body["telegramUserId"] !== "number" || typeof body["seerrUserId"] !== "number") {
    return error(res, "Missing telegramUserId or seerrUserId");
  }
  const telegramUserId = body["telegramUserId"];
  const seerrUserId = body["seerrUserId"];

  const seerrUser = await seerr.getUser(seerrUserId);
  if (!seerrUser) return error(res, "Seerr user not found", 404);

  const link: AccountLink = {
    telegramUserId,
    seerrUserId: seerrUser.id,
    seerrUsername: seerrUser.username || seerrUser.email,
    linkedAt: Date.now(),
  };
  accountStore.set(link);
  pendingStore.remove(telegramUserId);

  if (botInstance && config.MINI_APP_URL) {
    const kb = new InlineKeyboard().webApp("Open Teleseerr", config.MINI_APP_URL);
    botInstance.api
      .sendMessage(
        telegramUserId,
        "Your account has been linked! You can now browse and request media.",
        { reply_markup: kb },
      )
      .catch((e: unknown) => {
        log.error(e, "Failed to notify user about linking");
      });
  }

  json(res, link, 201);
}

export async function handleAdminIgnore({ req, res }: RouteContext): Promise<void> {
  const body = await parseJsonBody(req);
  if (typeof body["telegramUserId"] !== "number") return error(res, "Missing telegramUserId");
  pendingStore.ignore(body["telegramUserId"]);
  json(res, { success: true });
}

export async function handleAdminIgnored({ res, url }: RouteContext): Promise<void> {
  // Keep the ID-only response compatible with already-open older clients.
  if (url.searchParams.get("details") !== "1") return json(res, pendingStore.getIgnored());
  const bot = botInstance;
  if (bot) {
    const users = pendingStore.getIgnoredUsers();
    const ids = new Set(users.map((user) => user.telegramUserId));
    for (const id of profileLookupAttempts.keys())
      if (!ids.has(id)) profileLookupAttempts.delete(id);
    const missing = users
      .filter(
        (user) =>
          !user.firstName &&
          !user.username &&
          Date.now() - (profileLookupAttempts.get(user.telegramUserId) ?? 0) >= 60_000,
      )
      .slice(0, 4);
    await Promise.all(
      missing.map(async (user) => {
        profileLookupAttempts.set(user.telegramUserId, Date.now());
        try {
          // grammY types reference its AbortSignal polyfill; Node's native signal supports the same API.
          const signal = AbortSignal.timeout(5000) as unknown as NonNullable<
            Parameters<typeof bot.api.getChat>[1]
          >;
          const chat = await bot.api.getChat(user.telegramUserId, signal);
          if (chat.type === "private")
            pendingStore.setIgnoredProfile({
              telegramUserId: user.telegramUserId,
              firstName: chat.first_name,
              lastName: chat.last_name,
              username: chat.username,
            });
        } catch {
          /* Deleted/inaccessible accounts retain their Telegram ID. */
        }
      }),
    );
  }
  json(res, pendingStore.getIgnoredUsers());
}

export async function handleAdminUnignore({ req, res }: RouteContext): Promise<void> {
  const body = await parseJsonBody(req);
  if (typeof body["telegramUserId"] !== "number") return error(res, "Missing telegramUserId");
  pendingStore.unignore(body["telegramUserId"]);
  json(res, { success: true });
}

export async function handleAdminUnlink({ req, res }: RouteContext): Promise<void> {
  const body = await parseJsonBody(req);
  if (typeof body["telegramUserId"] !== "number") return error(res, "Missing telegramUserId");
  accountStore.delete(body["telegramUserId"]);
  json(res, { success: true });
}

export async function handleAdminDownloadPermission({
  req,
  res,
  auth,
}: RouteContext): Promise<void> {
  if (auth.userId !== config.ADMIN_USER_ID) return error(res, "Forbidden", 403);
  const body = await parseJsonBody(req);
  const id = body["telegramUserId"];
  if (
    typeof id !== "number" ||
    !Number.isSafeInteger(id) ||
    id <= 0 ||
    typeof body["enabled"] !== "boolean"
  )
    return error(res, "Invalid permission settings");
  const account = accountStore.get(id);
  if (!account) return error(res, "Account not linked", 404);
  accountStore.set({ ...account, manageDownloads: body["enabled"] });
  log.info(
    { actor: auth.userId, telegramUserId: id, enabled: body["enabled"] },
    "download permission changed",
  );
  json(res, { success: true });
}
