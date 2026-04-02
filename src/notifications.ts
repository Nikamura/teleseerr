import type { Bot } from "grammy";
import { log } from "./logger.js";
import { accountStore } from "./stores.js";
import * as seerr from "./seerr/client.js";

// ── Seerr Webhook Payload ─────────────────────────

export type SeerrWebhookPayload = {
  notification_type: string;
  subject: string;
  message?: string;
  media?: {
    media_type?: string;
    tmdbId?: string;
    status?: string;
    status4k?: string;
  };
  request?: {
    request_id?: string;
    requestedBy_username?: string;
    requestedBy_email?: string;
    requestedBy_avatar?: string;
  };
  extra?: unknown[];
};

// ── Helpers ───────────────────────────────────────

function escNotify(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

function findTelegramUserByUsername(username: string): number | undefined {
  return accountStore.getAll().find((l) => l.seerrUsername === username)?.telegramUserId;
}

function buildMessage(notificationType: string, subject: string): string | null {
  const title = escNotify(subject);

  switch (notificationType) {
    case "MEDIA_AVAILABLE":
      return `✅ *${title}* is now available\\! Time to watch, matey\\! 🏴‍☠️`;
    case "MEDIA_APPROVED":
      return `⚙️ *${title}* has been approved and is being downloaded\\!`;
    case "MEDIA_DECLINED":
      return `🔴 *${title}* request was declined by the admiral\\.`;
    case "MEDIA_FAILED":
      return `🔴 *${title}* request failed\\.`;
    default:
      return null;
  }
}

// ── Webhook Handler ─────────────────────────────────

export async function handleWebhook(payload: SeerrWebhookPayload, bot: Bot): Promise<void> {
  const { notification_type, subject, request } = payload;

  log.info({ notification_type, subject }, "Seerr webhook received");

  const message = buildMessage(notification_type, subject);
  if (!message) {
    log.debug({ notification_type }, "Ignoring unhandled webhook type");
    return;
  }

  // Try to find the telegram user — by username from the webhook payload
  const username = request?.requestedBy_username ?? request?.requestedBy_email;
  const telegramUserId = username ? findTelegramUserByUsername(username) : undefined;

  if (!telegramUserId) {
    log.warn({ notification_type, username }, "No linked Telegram user for webhook notification");
    return;
  }

  try {
    await bot.api.sendMessage(telegramUserId, message, {
      parse_mode: "MarkdownV2",
    });
    log.info(
      { telegramUser: telegramUserId, notification_type, subject },
      "Webhook notification sent",
    );
  } catch (e) {
    log.warn(
      { telegramUser: telegramUserId, notification_type, err: e },
      "Failed to send webhook notification",
    );
  }
}

// ── Auto-Approve Notification ──────────────────────

export function sendAutoApproveNotification(
  bot: Bot,
  telegramUserId: number,
  mediaType: "movie" | "tv",
  tmdbId: number,
): void {
  (async () => {
    let title: string;
    try {
      if (mediaType === "movie") {
        const details = await seerr.getMovieDetails(tmdbId);
        title = details.title ?? `TMDB#${tmdbId}`;
      } else {
        const details = await seerr.getTvDetails(tmdbId);
        title = details.name ?? `TMDB#${tmdbId}`;
      }
    } catch {
      title = `TMDB#${tmdbId}`;
    }

    const escaped = escNotify(title);
    await bot.api.sendMessage(
      telegramUserId,
      `⚙️ *${escaped}* has been approved and is being downloaded\\!`,
      { parse_mode: "MarkdownV2" },
    );
    log.info({ telegramUser: telegramUserId, mediaType, tmdbId }, "Auto-approve notification sent");
  })().catch((e: unknown) => {
    log.warn(
      { telegramUser: telegramUserId, mediaType, tmdbId, err: e },
      "Failed to send auto-approve notification",
    );
  });
}
