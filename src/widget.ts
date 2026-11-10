// Live request widget (Bot API 10.4): one DM per request that the bot updates in place.
// grammY 1.46 covers Bot API 10.3, so the three widget methods are called through the raw API
// with local types, and widget_query updates are read from the untyped update object.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import {
  GrammyError,
  type Bot,
  type Context,
  type InlineKeyboard,
  type NextFunction,
} from "grammy";
import { config } from "./config.js";
import { log } from "./logger.js";
import { getMovieProgress, getTvProgress } from "./arr/client.js";
import * as seerr from "./seerr/client.js";

export type WidgetStatus =
  "approved" | "waiting" | "downloading" | "importing" | "available" | "declined" | "failed";

/** chat_data payload. Short keys: the whole state must fit in 1024 bytes. */
export type WidgetState = {
  /** Revision; the widget ignores anything older than what it already drew. */
  r: number;
  /** Title. */
  t: string;
  s: WidgetStatus;
  /** Download percent. */
  p?: number;
  /** Time left, as reported by the download service. */
  e?: string;
  /** Short note under the status. */
  n?: string;
};

type Entry = {
  requestId: number;
  userId: number;
  messageId: number;
  type: "movie" | "tv";
  tmdbId: number;
  /** TMDB poster path, kept so a replacement widget can show the same poster. */
  posterPath?: string;
  state: WidgetState;
};

type Target = Omit<Entry, "messageId" | "state">;

type WidgetApi = {
  sendWidget(args: {
    chat_id: number;
    html: string;
    chat_data: string;
    caption: string;
    parse_mode?: "MarkdownV2";
    allow_queries: boolean;
    message_effect_id?: string;
    reply_markup?: InlineKeyboard;
  }): Promise<{ message_id: number }>;
  editMessageWidgetData(args: {
    chat_id: number;
    message_id: number;
    chat_data: string;
  }): Promise<true>;
  answerWidgetQuery(args: { widget_query_id: string; data?: string }): Promise<true>;
};
const widgetApi = (bot: Pick<Bot, "api">): WidgetApi => bot.api.raw as unknown as WidgetApi;

// Fixed at send time; only chat_data changes. No network, no external resources, no form
// controls. Limits: 32768 bytes, 4096 bytes after zlib level 9 (checked by tests and at send).
// The optional poster is a tiny data: image, the only image source widgets allow.
export const widgetHtml = (poster?: string): string => `<style>
body{margin:0;padding:12px 14px;font:14px/1.35 system-ui,sans-serif;color:var(--tg-theme-text-color)}
.h{display:flex;gap:10px;align-items:center}
.h img{width:45px;height:68px;flex:none;border-radius:4px;object-fit:cover}
.h div{min-width:0}
h3{margin:0 0 2px;font-size:16px;overflow-wrap:anywhere}
#s{font-weight:600}
#m{color:var(--tg-theme-hint-color);font-size:12px;min-height:16px}
.t{height:6px;border-radius:3px;background:var(--tg-theme-secondary-bg-color,#8884);margin:10px 0 6px;overflow:hidden}
#b{height:100%;width:0;border-radius:3px;background:var(--tg-theme-button-color,#39f);transition:width .4s}
button{margin-top:8px;width:100%}
</style>
<div class="h">${poster ? `<img src="${poster}" alt="">` : ""}<div><h3 id="t">Request</h3><div id="s"></div></div></div><div class="t"><div id="b"></div></div><div id="m"></div><button id="r">Refresh</button>
<script>
var W=window.TelegramWidget,rev=-1,busy=0;
var L={approved:"Approved · queued",waiting:"Approved · waiting for release",downloading:"Downloading",importing:"Preparing for playback",available:"Ready to watch",declined:"Declined",failed:"Failed"};
function $(i){return document.getElementById(i)}
function read(){try{return JSON.parse(W.chatData)}catch(e){return null}}
function over(s){return s=="available"||s=="declined"}
function draw(){var d=read();if(!d||d.r<rev)return;rev=d.r;
$("t").textContent=d.t||"Request";$("s").textContent=L[d.s]||d.s;
var p=d.s=="available"?100:d.p||0;$("b").style.width=p+"%";
$("m").textContent=d.s=="downloading"?p+"%"+(d.e?" · "+d.e+" left":""):d.n||"";
$("r").style.display=over(d.s)?"none":""}
function ask(){if(busy||!W.viewer)return;busy=1;$("r").textContent="Refreshing…";
W.request("p").catch(function(e){if(e&&e.code=="NOT_ALLOWED")$("m").textContent="Open the bot chat to refresh"}).then(function(){busy=0;$("r").textContent="Refresh"})}
if(W){$("r").addEventListener("click",ask);W.onEvent("chatDataChanged",draw);draw();
setInterval(function(){var d=read();if(d&&!over(d.s)&&d.s!="failed"&&W.isActive&&!W.isForward)ask()},20000);
W.ready()}
</script>`;
export const WIDGET_HTML = widgetHtml();

const fitsLimits = (html: string): boolean =>
  Buffer.byteLength(html) <= 32768 && deflateSync(html, { level: 9 }).length <= 4096;

/** TMDB's smallest poster (45×68, ~2 KB) as a data: URI, or undefined when unavailable. */
export async function fetchPoster(posterPath: string | undefined): Promise<string | undefined> {
  if (!posterPath || !/^\/[\w-]+\.(?:jpe?g|png|webp)$/i.test(posterPath)) return undefined;
  try {
    const response = await fetch(`${config.TMDB_IMAGE_BASE}/w45${posterPath}`, {
      signal: AbortSignal.timeout(5000),
    });
    const type = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
    if (!response.ok || !/^image\/(?:jpeg|png|webp)$/.test(type)) return undefined;
    const bytes = Buffer.from(await response.arrayBuffer());
    return bytes.length <= 3072 ? `data:${type};base64,${bytes.toString("base64")}` : undefined;
  } catch {
    return undefined;
  }
}

// ── Store ─────────────────────────────────────────

const file = join(config.DATA_DIR, "widgets.json");
const MAX_ENTRIES = 500;
let entries: Entry[] = [];
if (existsSync(file)) {
  try {
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (Array.isArray(raw)) entries = (raw as Entry[]).slice(-MAX_ENTRIES);
  } catch {
    log.warn("Could not read live widget state; existing widgets will no longer update");
  }
}
function save(entry: Entry): void {
  entries = entries
    .filter((item) => item.requestId !== entry.requestId)
    .concat(entry)
    .slice(-MAX_ENTRIES);
  mkdirSync(config.DATA_DIR, { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(entries), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

// ── State ─────────────────────────────────────────

function clipBytes(value: string, max: number): string {
  let out = value;
  while (Buffer.byteLength(out) > max) out = out.slice(0, -1);
  return out;
}

export function encodeState(state: WidgetState): string {
  const compact: WidgetState = {
    r: state.r,
    t: clipBytes(state.t, 300),
    s: state.s,
    ...(state.p === undefined ? {} : { p: state.p }),
    ...(state.e ? { e: clipBytes(state.e, 40) } : {}),
    ...(state.n ? { n: clipBytes(state.n, 200) } : {}),
  };
  return JSON.stringify(compact);
}

const terminal = (status: WidgetStatus): boolean => status === "available" || status === "declined";

// ── Sending and updating ──────────────────────────

export function widgetEnabled(): boolean {
  return config.LIVE_WIDGET;
}

type SendOptions = { keyboard?: InlineKeyboard; effectId?: string };

async function post(
  bot: Pick<Bot, "api">,
  target: Target,
  state: WidgetState,
  caption: string,
  options: SendOptions,
): Promise<number> {
  const poster = await fetchPoster(target.posterPath);
  const withPoster = widgetHtml(poster);
  const args = {
    chat_id: target.userId,
    html: poster && fitsLimits(withPoster) ? withPoster : WIDGET_HTML,
    chat_data: encodeState(state),
    // Shown in notifications, the chat list and on clients without widget support.
    caption,
    parse_mode: "MarkdownV2" as const,
    allow_queries: true,
    ...(options.keyboard ? { reply_markup: options.keyboard } : {}),
  };
  if (!options.effectId) return (await widgetApi(bot).sendWidget(args)).message_id;
  try {
    return (await widgetApi(bot).sendWidget({ ...args, message_effect_id: options.effectId }))
      .message_id;
  } catch (error) {
    // An unknown effect is rejected; the message matters more than the effect.
    if (!(error instanceof GrammyError) || error.error_code !== 400) throw error;
    return (await widgetApi(bot).sendWidget(args)).message_id;
  }
}

/** Sends the widget message. Throws on failure so the caller can fall back to a plain DM. */
export async function sendRequestWidget(
  bot: Pick<Bot, "api">,
  target: Target,
  title: string,
  status: WidgetStatus,
  caption: string,
  keyboard?: InlineKeyboard,
): Promise<void> {
  const state: WidgetState = { r: 1, t: title, s: status };
  const messageId = await post(bot, target, state, caption, keyboard ? { keyboard } : {});
  save({ ...target, messageId, state });
}

/**
 * Edits are silent, so "available" replaces the widget instead: a fresh message notifies, then the
 * old one is deleted. Bots can only delete their messages for 48 hours; an older widget is marked
 * available in place and stays. Returns false without a widget; throws if the send fails.
 */
export async function replaceRequestWidget(
  bot: Pick<Bot, "api">,
  requestId: number,
  caption: string,
  options: SendOptions,
): Promise<boolean> {
  const entry = entries.find((item) => item.requestId === requestId);
  if (!entry) return false;
  const state: WidgetState = { r: entry.state.r + 1, t: entry.state.t, s: "available" };
  const messageId = await post(bot, entry, state, caption, options);
  save({ ...entry, messageId, state });
  try {
    await bot.api.deleteMessage(entry.userId, entry.messageId);
  } catch (error) {
    log.debug({ requestId, err: error }, "Old live widget not deleted; marking it available");
    // Not apply(): the store now tracks the new message.
    await widgetApi(bot)
      .editMessageWidgetData({
        chat_id: entry.userId,
        message_id: entry.messageId,
        chat_data: encodeState(state),
      })
      .catch((err: unknown) => log.warn({ requestId, err }, "Live widget update failed"));
  }
  return true;
}

async function apply(
  bot: Pick<Bot, "api">,
  entry: Entry,
  patch: Partial<Omit<WidgetState, "r" | "t">>,
): Promise<void> {
  const next: WidgetState = { r: entry.state.r + 1, t: entry.state.t, s: patch.s ?? entry.state.s };
  if (next.s === "downloading" && patch.p !== undefined) next.p = patch.p;
  if (next.s === "downloading" && patch.e) next.e = patch.e;
  if (patch.n) next.n = patch.n;
  // An unchanged edit is rejected by Telegram ("message is not modified") and still costs a call.
  if (encodeState({ ...next, r: 0 }) === encodeState({ ...entry.state, r: 0 })) return;
  await widgetApi(bot).editMessageWidgetData({
    chat_id: entry.userId,
    message_id: entry.messageId,
    chat_data: encodeState(next),
  });
  save({ ...entry, state: next });
}

export function widgetStatus(requestId: number): WidgetStatus | undefined {
  return entries.find((item) => item.requestId === requestId)?.state.s;
}

/** Silent in-place update from a Seerr event. Never throws: the DM remains the notification. */
export async function updateRequestWidget(
  bot: Pick<Bot, "api">,
  requestId: number,
  status: WidgetStatus,
  note?: string,
): Promise<void> {
  const entry = entries.find((item) => item.requestId === requestId);
  if (!entry) return;
  try {
    await apply(bot, entry, { s: status, ...(note ? { n: note } : {}) });
  } catch (error) {
    log.warn({ requestId, err: error }, "Live widget update failed");
  }
}

// ── Queries from the widget ───────────────────────

async function refreshed(entry: Entry): Promise<Partial<Omit<WidgetState, "r" | "t">>> {
  const request = await seerr.getRequest(entry.requestId);
  if (!request) return {};
  if (request.status === 3) return { s: "declined" };
  const mediaStatus = request.is4k ? request.media?.status4k : request.media?.status;
  if (request.status === 5 || mediaStatus === 5) return { s: "available" };
  if (request.status === 4) return { s: "failed" };
  const progress =
    entry.type === "movie"
      ? await getMovieProgress(entry.tmdbId)
      : await getTvProgress(entry.tmdbId);
  const items = progress.items.filter((item) => item.status !== "available");
  if (!items.length) return {};
  const total = items.reduce((sum, item) => sum + item.sizeTotal, 0);
  const done = items.reduce((sum, item) => sum + item.sizeDownloaded, 0);
  if (items.every((item) => item.status === "importing")) return { s: "importing" };
  const eta = items.find((item) => item.status === "downloading")?.eta;
  const stuck = items.find((item) => item.status === "stalled" || item.status === "failed");
  return {
    s: "downloading",
    p: total > 0 ? Math.round((done / total) * 100) : 0,
    ...(eta ? { e: eta } : {}),
    ...(stuck ? { n: "A download needs attention" } : {}),
  };
}

type WidgetQuery = {
  id: string;
  from: { id: number };
  chat?: { id: number };
  message_id?: number;
  data?: string;
};

function widgetQuery(update: object): WidgetQuery | undefined {
  const query = (update as { widget_query?: Partial<WidgetQuery> }).widget_query;
  return query && typeof query.id === "string" && typeof query.from?.id === "number"
    ? (query as WidgetQuery)
    : undefined;
}

const lastRefresh = new Map<number, number>();

/** Answers every widget query; only the owner's "p" (progress) request touches upstream services. */
export async function handleWidgetQuery(bot: Pick<Bot, "api">, update: object): Promise<boolean> {
  const query = widgetQuery(update);
  if (!query) return false;
  try {
    const entry = entries.find(
      (item) => item.messageId === query.message_id && item.userId === query.chat?.id,
    );
    const now = Date.now();
    if (
      entry &&
      query.data === "p" &&
      query.from.id === entry.userId &&
      !terminal(entry.state.s) &&
      now - (lastRefresh.get(entry.requestId) ?? 0) >= 10_000
    ) {
      lastRefresh.set(entry.requestId, now);
      if (lastRefresh.size > MAX_ENTRIES) lastRefresh.clear();
      // Queries expire after 15 seconds; a slow upstream must not block the answer.
      const patch = await Promise.race([
        refreshed(entry),
        new Promise<null>((resolve) => setTimeout(resolve, 8000, null).unref()),
      ]);
      if (patch && Object.keys(patch).length) await apply(bot, entry, patch);
    }
  } catch (error) {
    log.debug({ err: error }, "Live widget refresh failed");
  } finally {
    await widgetApi(bot)
      .answerWidgetQuery({ widget_query_id: query.id })
      .catch((error: unknown) => log.debug({ err: error }, "Widget query answer failed"));
  }
  return true;
}

export function widgetQueries(bot: Bot): (ctx: Context, next: NextFunction) => Promise<void> {
  return async (ctx, next) => {
    if (!(await handleWidgetQuery(bot, ctx.update))) await next();
  };
}
