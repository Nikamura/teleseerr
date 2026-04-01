import { InlineKeyboard, type Bot } from "grammy";
import { json, error, parseJsonBody, pageParam, type RouteContext } from "../http.js";
import { accountStore, pendingStore } from "../stores.js";
import * as seerr from "../seerr/client.js";
import { config } from "../config.js";
import { log } from "../logger.js";
import type { AccountLink } from "../types.js";

// ── Bot Instance (set by server.ts on startup) ───

let botInstance: Bot | null = null;

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

export function handleAdminIgnored({ res }: RouteContext): void {
  json(res, pendingStore.getIgnored());
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
