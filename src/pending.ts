import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { config } from "./config.js";
import { log } from "./logger.js";
import { pendingStore } from "./stores.js";

type PendingUserInfo = {
  userId: number;
  firstName?: string | undefined;
  lastName?: string | undefined;
  username?: string | undefined;
};

export function addPendingAndNotify(bot: Bot, user: PendingUserInfo): void {
  const isNew = pendingStore.add({
    telegramUserId: user.userId,
    firstName: user.firstName,
    lastName: user.lastName,
    username: user.username,
    requestedAt: Date.now(),
  });

  if (!isNew) return;

  const name = [user.firstName, user.lastName].filter(Boolean).join(" ") || "Unknown";
  const userTag = user.username ? ` (@${user.username})` : "";
  const text = `New user wants access!\n\nName: ${name}${userTag}\nTelegram ID: ${user.userId}`;

  const kb = config.MINI_APP_URL
    ? new InlineKeyboard().webApp("Link account", config.MINI_APP_URL)
    : undefined;

  bot.api
    .sendMessage(config.ADMIN_USER_ID, text, kb ? { reply_markup: kb } : undefined)
    .catch((e: unknown) => {
      log.error(e, "Failed to notify admin about unlinked user");
    });
}
