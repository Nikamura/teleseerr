import { webhookEvent, matchesRequest } from "./webhook-event.js";
import { join } from "node:path";
import { config } from "./config.js";
import { RetryQueue } from "./retry.js";
import { NotificationDelivery } from "./notification-delivery.js";
import { waitingForRelease } from "./arr/availability.js";
import { cleanupStatus } from "./arr/cleanup.js";
import { GrammyError, InlineKeyboard, type Bot } from "grammy";
import { log } from "./logger.js";
import { accountStore } from "./stores.js";
import * as seerr from "./seerr/client.js";
import {
  sendRequestWidget,
  updateRequestWidget,
  widgetEnabled,
  widgetStatus,
  type WidgetStatus,
} from "./widget.js";

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

// Telegram's free "🎉" message effect (private chats only). The ID cannot be checked without a
// client, so a rejected effect is resent without it rather than losing the notification.
const AVAILABLE_EFFECT_ID = "5046509860389126442";

type Target = { type: string; tmdbId: number };

function titleKeyboard(target: Target | undefined, highlight: boolean): InlineKeyboard | undefined {
  if (!config.MINI_APP_URL || !target || (target.type !== "movie" && target.type !== "tv"))
    return undefined;
  const keyboard = new InlineKeyboard().webApp(
    "Open title",
    new URL(`/${target.type}/${target.tmdbId}`, config.MINI_APP_URL).href,
  );
  // Button styles (Bot API 9.4) are ignored by older clients.
  return highlight ? keyboard.success() : keyboard;
}

async function sendNotification(
  bot: Bot,
  userId: number,
  requestId: number,
  type: string,
  message: string,
  target?: Target,
  widget?: { title: string; status: WidgetStatus },
): Promise<void> {
  const event = type === "MEDIA_AUTO_APPROVED" ? "MEDIA_APPROVED" : type;
  const available = event === "MEDIA_AVAILABLE";
  const keyboard = titleKeyboard(target, available);
  const options = {
    parse_mode: "MarkdownV2" as const,
    ...(keyboard ? { reply_markup: keyboard } : {}),
  };
  await delivery.send(`${requestId}:${event}:${userId}`, async () => {
    if (widget && widgetEnabled() && (target?.type === "movie" || target?.type === "tv")) {
      try {
        await sendRequestWidget(
          bot,
          { requestId, userId, type: target.type, tmdbId: target.tmdbId },
          widget.title,
          widget.status,
          message,
          keyboard,
        );
        return;
      } catch (error) {
        log.warn({ requestId, err: error }, "Live widget not sent; using a plain notification");
      }
    }
    if (!available) {
      await bot.api.sendMessage(userId, message, options);
      return;
    }
    try {
      await bot.api.sendMessage(userId, message, {
        ...options,
        message_effect_id: AVAILABLE_EFFECT_ID,
      });
    } catch (error) {
      if (!(error instanceof GrammyError) || error.error_code !== 400) throw error;
      await bot.api.sendMessage(userId, message, options);
    }
  });
}

/**
 * MarkdownV2 date_time entity (Bot API 9.5): rendered in the reader's timezone and locale. The
 * UTC text is what older clients and notifications show.
 */
export function dateTime(ms: number, format: "D" | "t" | "dt"): string {
  const unix = Math.floor(ms / 1000);
  const at = new Date(unix * 1000);
  const date = at.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
  const time = at.toISOString().slice(11, 16) + " UTC";
  const text = format === "D" ? date : format === "t" ? time : `${date} ${time}`;
  return `![${escNotify(text)}](tg://time?unix=${unix}&format=${format})`;
}

async function approvalMessage(
  title: string,
  request: seerr.RequestDetails,
  releaseDate?: string,
): Promise<string> {
  if (!(await waitingForRelease(request))) return queuedMessage(title);
  const release = Date.parse(releaseDate ?? "");
  // A release date is a calendar day, not an instant: noon UTC keeps the same day in most zones.
  const day = Math.floor(release / 86400_000) * 86400_000 + 43200_000;
  return (
    "🕒 *" +
    escNotify(title) +
    "* has been approved and is waiting for release availability\\." +
    (Number.isFinite(release) && day > Date.now() ? ` Release date: ${dateTime(day, "D")}\\.` : "")
  );
}

const queuedMessage = (title: string): string =>
  "⚙️ *" + escNotify(title) + "* has been approved and queued for processing\\!";
// The approval text already says which of the two approved states applies.
const approvalStatus = (message: string): WidgetStatus =>
  message.startsWith("🕒") ? "waiting" : "approved";

async function cleanupNote(type: string, tmdbId: number): Promise<string> {
  const { items } = await cleanupStatus(type, tmdbId);
  // Season-level cleanup may concern a season other than the requested one; skip it.
  const times = items
    .filter((item) => item.season === null)
    .map((item) => Date.parse(item.eligibleAt ?? ""))
    .filter((time) => Number.isFinite(time) && time > Date.now());
  return times.length
    ? `\n🧹 Library cleanup may remove it from ${dateTime(Math.min(...times), "D")}\\.`
    : "";
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
  let releaseDate: string | undefined;
  const target = request.media?.tmdbId
    ? { type: request.type, tmdbId: request.media.tmdbId }
    : undefined;
  if (request.media?.tmdbId) {
    try {
      const details =
        request.type === "movie"
          ? await seerr.getMovieDetails(request.media.tmdbId)
          : await seerr.getTvDetails(request.media.tmdbId);
      title = ("title" in details ? details.title : details.name) ?? title;
      releaseDate = details.releaseDate;
    } catch {
      /* Safe request-ID fallback; never fall back to webhook subject. */
    }
  }
  let message = buildMessage(type, title);
  if (!message) return;
  if (type === "MEDIA_AVAILABLE" || type === "MEDIA_DECLINED") retryQueue?.cancel(requestId);
  if (type === "MEDIA_AVAILABLE" && target)
    message += await cleanupNote(target.type, target.tmdbId);
  if (type === "MEDIA_FAILED" && retryQueue?.enqueue(requestId, request.requestedBy.id)) {
    const due = retryQueue.due(requestId);
    message =
      "⚠️ *" +
      escNotify(title) +
      "* request failed\\. " +
      (due === null
        ? "Automatic retries are scheduled\\."
        : `Next automatic retry: ${dateTime(due, "t")}\\.`);
  }
  const approved = type === "MEDIA_APPROVED" || type === "MEDIA_AUTO_APPROVED";
  if (approved) message = await approvalMessage(title, request, releaseDate);
  // Edits are silent, so the DM below stays the notification; the widget only mirrors state.
  if (type === "MEDIA_AVAILABLE") await updateRequestWidget(bot, requestId, "available");
  else if (type === "MEDIA_DECLINED") await updateRequestWidget(bot, requestId, "declined");
  else if (type === "MEDIA_FAILED")
    await updateRequestWidget(
      bot,
      requestId,
      "failed",
      retryQueue?.due(requestId) != null ? "Retrying automatically" : undefined,
    );
  else if (approved && widgetStatus(requestId) === "failed")
    await updateRequestWidget(bot, requestId, approvalStatus(message));
  try {
    await sendNotification(
      bot,
      userId,
      requestId,
      type,
      message,
      target,
      approved ? { title, status: approvalStatus(message) } : undefined,
    );
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
    let releaseDate: string | undefined;
    const target = { type: mediaType, tmdbId };
    try {
      if (mediaType === "movie") {
        const details = await seerr.getMovieDetails(tmdbId);
        title = details.title ?? `TMDB#${tmdbId}`;
        releaseDate = details.releaseDate;
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
      ? await approvalMessage(title, request, releaseDate)
      : queuedMessage(title);
    const keyboard = titleKeyboard(target, false);
    if (requestId)
      await sendNotification(bot, telegramUserId, requestId, "MEDIA_APPROVED", message, target, {
        title,
        status: approvalStatus(message),
      });
    else
      await bot.api.sendMessage(telegramUserId, message, {
        parse_mode: "MarkdownV2",
        ...(keyboard ? { reply_markup: keyboard } : {}),
      });
    log.info({ telegramUser: telegramUserId, mediaType, tmdbId }, "Auto-approve notification sent");
  })().catch((e: unknown) => {
    log.warn(
      { telegramUser: telegramUserId, mediaType, tmdbId, err: e },
      "Failed to send auto-approve notification",
    );
  });
}
