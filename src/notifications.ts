import { webhookEvent, matchesRequest } from "./webhook-event.js";
import { join } from "node:path";
import { config } from "./config.js";
import { RetryQueue } from "./retry.js";
import { NotificationDelivery } from "./notification-delivery.js";
import { waitingForRelease } from "./arr/availability.js";
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
  };
  extra?: unknown[];
};

const delivery = new NotificationDelivery();
let retryQueue: RetryQueue | undefined;

export function startRetries(bot: Bot): void {
  if (!config.AUTO_RETRY_FAILED) return;
  if (!config.WEBHOOK_SECRET || !config.MINI_APP_URL) {
    throw new Error("Automatic retries require the Mini App server and webhook secret");
  }
  retryQueue = new RetryQueue(join(config.DATA_DIR, "retries.json"), config.RETRY_DELAYS_SECONDS, {
    inspect: seerr.getRequest,
    linked: (userId) => findTelegramUserBySeerrId(userId) !== undefined,
    retry: seerr.retryRequest,
    exhausted: async (job) => {
      const user = findTelegramUserBySeerrId(job.userId);
      if (user !== undefined)
        await bot.api.sendMessage(
          user,
          "Automatic retry budget used for request #" +
            String(job.id) +
            ". Check Seerr if it still fails.",
        );
    },
    report: (error) => log.warn({ err: error }, "Automatic request retry error"),
  });
  const queue = retryQueue;
  setInterval(() => {
    void queue.tick();
  }, 1000).unref();
}

async function sendNotification(
  bot: Bot,
  userId: number,
  requestId: number,
  type: string,
  message: string,
): Promise<void> {
  const event = type === "MEDIA_AUTO_APPROVED" ? "MEDIA_APPROVED" : type;
  await delivery.send(`${requestId}:${event}:${userId}`, async () => {
    await bot.api.sendMessage(userId, message, { parse_mode: "MarkdownV2" });
  });
}

async function approvalMessage(title: string, request: seerr.RequestDetails): Promise<string> {
  return (await waitingForRelease(request))
    ? "🕒 *" + escNotify(title) + "* has been approved and is waiting for release availability\\."
    : "⚙️ *" + escNotify(title) + "* has been approved and queued for processing\\!";
}

// ── Helpers ───────────────────────────────────────

function escNotify(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

function findTelegramUserBySeerrId(seerrUserId: number): number | undefined {
  return accountStore.getAll().find((l) => l.seerrUserId === seerrUserId)?.telegramUserId;
}

function buildMessage(notificationType: string, subject: string): string | null {
  const title = escNotify(subject);

  switch (notificationType) {
    case "MEDIA_AVAILABLE":
      return `✅ *${title}* is now available\\! Time to watch, matey\\! 🏴‍☠️`;
    case "MEDIA_APPROVED":
    case "MEDIA_AUTO_APPROVED":
      return `⚙️ *${title}* has been approved and queued for processing\\!`;
    case "MEDIA_DECLINED":
      return `🔴 *${title}* request was declined by the admiral\\.`;
    case "MEDIA_FAILED":
      return `🔴 *${title}* request failed\\.`;
    default:
      return null;
  }
}

// ── Webhook Handler ─────────────────────────────────

export async function handleWebhook(payload: unknown, bot: Bot): Promise<void> {
  const event = webhookEvent(payload);
  if (!event) return;
  const { type, requestId } = event;
  const request = await seerr.getRequest(requestId);
  if (!request || !matchesRequest(type, request)) {
    log.debug({ requestId, type }, "Ignoring webhook inconsistent with current Seerr state");
    return;
  }
  const userId = findTelegramUserBySeerrId(request.requestedBy.id);
  if (userId === undefined) return;
  // Titles come from the authenticated Seerr API, never webhook-controlled text.
  let title = "Request #" + String(requestId);
  if (request.media?.tmdbId) {
    try {
      const details =
        request.type === "movie"
          ? await seerr.getMovieDetails(request.media.tmdbId)
          : await seerr.getTvDetails(request.media.tmdbId);
      title = ("title" in details ? details.title : details.name) ?? title;
    } catch {
      /* Safe request-ID fallback; never fall back to webhook subject. */
    }
  }
  let message = buildMessage(type, title);
  if (!message) return;
  if (type === "MEDIA_AVAILABLE" || type === "MEDIA_DECLINED") retryQueue?.cancel(requestId);
  if (type === "MEDIA_FAILED" && retryQueue?.enqueue(requestId, request.requestedBy.id)) {
    message = "⚠️ *" + escNotify(title) + "* request failed\\. Automatic retries are scheduled\\.";
  }
  if (type === "MEDIA_APPROVED" || type === "MEDIA_AUTO_APPROVED")
    message = await approvalMessage(title, request);
  try {
    await sendNotification(bot, userId, requestId, type, message);
  } catch (error) {
    log.warn({ requestId, type, err: error }, "Webhook notification delivery failed");
  }
}

// ── Auto-Approve Notification ──────────────────────

export function sendAutoApproveNotification(
  bot: Bot,
  telegramUserId: number,
  mediaType: "movie" | "tv",
  tmdbId: number,
  requestId?: number,
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

    // Enrichment must not suppress a confirmation after successful request creation.
    const request = requestId ? await seerr.getRequest(requestId).catch(() => null) : null;
    const message = request
      ? await approvalMessage(title, request)
      : "⚙️ *" + escNotify(title) + "* has been approved and queued for processing\\!";
    if (requestId)
      await sendNotification(bot, telegramUserId, requestId, "MEDIA_APPROVED", message);
    else await bot.api.sendMessage(telegramUserId, message, { parse_mode: "MarkdownV2" });
    log.info({ telegramUser: telegramUserId, mediaType, tmdbId }, "Auto-approve notification sent");
  })().catch((e: unknown) => {
    log.warn(
      { telegramUser: telegramUserId, mediaType, tmdbId, err: e },
      "Failed to send auto-approve notification",
    );
  });
}
