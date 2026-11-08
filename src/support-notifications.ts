import type { Bot } from "grammy";
import { Api, InlineKeyboard } from "grammy";
import { config } from "./config.js";
import { log } from "./logger.js";
import { accountStore } from "./stores.js";
import {
  pendingReportNotifications,
  completeReportNotification,
  retryReportNotification,
  type ReportNotice,
} from "./support-store.js";

let reportBot: Pick<Bot, "api"> | undefined;
let sending = false;
const categories: Record<string, string> = {
  download: "Download stuck or missing",
  playback: "Playback problem",
  "wrong-episode": "Wrong episode",
  audio: "Audio / language",
  subtitles: "Subtitles",
  other: "Other problem",
};
const clip = (value: string, max: number): string =>
  value.length > max ? value.slice(0, max - 1) + "…" : value;
function identity(id: number): string {
  const name = accountStore.get(id)?.seerrUsername;
  return name ? `${clip(name, 100)} (Telegram ${id})` : `Telegram ${id}`;
}
export function reportMessage(item: ReportNotice): string {
  const r = item.report;
  const heading =
    item.event === "created"
      ? "🚩 New problem report"
      : item.event === "existing"
        ? "🚩 Existing unresolved report"
        : item.event === "resolved"
          ? "✅ User marked the problem fixed"
          : item.event === "reopened"
            ? "🚩 User reopened the problem"
            : "📝 User updated a problem report";
  const episode =
    r.season !== undefined && r.episode !== undefined
      ? ` · S${String(r.season).padStart(2, "0")}E${String(r.episode).padStart(2, "0")}`
      : r.episodeId
        ? ` · Episode ID ${r.episodeId}`
        : "";
  return [
    heading,
    "",
    clip(r.title ?? `TMDB ${r.tmdbId}`, 300) + episode,
    `Problem: ${categories[r.category] ?? clip(r.category, 100)}`,
    `Reported by: ${identity(r.owner)}`,
    ...(item.actor !== r.owner ? [`Updated by: ${identity(item.actor)}`] : []),
    ...(r.device ? [`Device / app: ${clip(r.device, 100)}`] : []),
    `Status: ${r.status.replaceAll("_", " ")}`,
    `Report: ${r.id}`,
    ...(r.notes ? ["", clip(r.notes, 2000)] : []),
    ...(item.message ? ["", `Update: ${clip(item.message, 1000)}`] : []),
  ]
    .join("\n")
    .slice(0, 4000);
}
export async function flushReportNotifications(bot = reportBot, now = Date.now()): Promise<void> {
  if (!bot || sending) return;
  sending = true;
  try {
    for (const item of pendingReportNotifications(now)) {
      try {
        const keyboard = config.MINI_APP_URL
          ? new InlineKeyboard()
              .webApp(
                "Open title",
                new URL(`/${item.report.type}/${item.report.tmdbId}`, config.MINI_APP_URL).href,
              )
              .row()
              .webApp("Requests & reports", new URL("/requests", config.MINI_APP_URL).href)
          : undefined;
        // Plain text: submitted notes cannot inject Telegram formatting or hidden links.
        await bot.api.sendMessage(config.ADMIN_USER_ID, reportMessage(item), {
          link_preview_options: { is_disabled: true },
          ...(keyboard ? { reply_markup: keyboard } : {}),
        });
        completeReportNotification(item.id);
        log.info(
          { reportId: item.report.id, noticeId: item.id },
          "Problem report delivered to admin Telegram",
        );
      } catch {
        retryReportNotification(item.id);
        log.warn(
          { reportId: item.report.id, noticeId: item.id },
          "Problem report Telegram notification will retry",
        );
      }
    }
  } finally {
    sending = false;
  }
}
export function wakeReportNotifications(): void {
  void flushReportNotifications().catch(() =>
    log.warn("Could not process problem-report notifications"),
  );
}
export function startReportNotifications(): void {
  reportBot = { api: new Api(config.TELEGRAM_BOT_TOKEN, { timeoutSeconds: 15 }) };
  wakeReportNotifications();
  setInterval(wakeReportNotifications, 30_000).unref();
}
