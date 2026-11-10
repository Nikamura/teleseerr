import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { runInNewContext } from "node:vm";
import type { Bot } from "grammy";

const dir = mkdtempSync(join(tmpdir(), "teleseerr-widget-"));
Object.assign(process.env, {
  TELESEERR_ALLOW_INSECURE_HTTP: "true",
  TELEGRAM_BOT_TOKEN: "dummy",
  SEERR_URL: "http://seerr.invalid",
  SEERR_API_KEY: "dummy",
  TELESEERR_ADMIN_USER_ID: "1",
  TELESEERR_DATA_DIR: dir,
  TELESEERR_MINI_APP_URL: "https://teleseerr.invalid",
  TELESEERR_LIVE_WIDGET: "true",
  TELESEERR_RADARR_URL: "http://radarr.invalid",
  TELESEERR_RADARR_API_KEY: "dummy",
  LOG_LEVEL: "silent",
});
const originalFetch = global.fetch;
after(() => {
  global.fetch = originalFetch;
  rmSync(dir, { recursive: true, force: true });
});
const modules = Promise.all([
  import("../src/widget.js"),
  import("../src/notifications.js"),
  import("../src/stores.js"),
]);
const request = { status: 2, requestedBy: { id: 7 }, type: "movie", is4k: false, media: { tmdbId: 10 } };

function fakeBot(options: { rejectWidget?: boolean; firstMessageId?: number; rejectDelete?: boolean } = {}) {
  const calls: { method: string; args: any }[] = [];
  let messageId = (options.firstMessageId ?? 501) - 1;
  const record = (method: string) => async (args: any) => {
    calls.push({ method, args });
    if (method === "sendWidget" && options.rejectWidget) throw new Error("Bad Request: method not found");
    return method === "sendWidget" ? { message_id: ++messageId } : true;
  };
  const bot = {
    api: {
      raw: {
        sendWidget: record("sendWidget"),
        editMessageWidgetData: record("editMessageWidgetData"),
        answerWidgetQuery: record("answerWidgetQuery"),
      },
      deleteMessage: async (chat_id: number, message_id: number) => {
        calls.push({ method: "deleteMessage", args: { chat_id, message_id } });
        if (options.rejectDelete) throw new Error("Bad Request: message can't be deleted");
        return true;
      },
      sendMessage: async (user: number, text: string, extra: any) => {
        calls.push({ method: "sendMessage", args: { user, text, extra } });
      },
    },
  } as unknown as Bot;
  return { bot, calls, of: (method: string) => calls.filter((call) => call.method === method) };
}

test("widget HTML respects Telegram limits and renders every state without network access", async () => {
  const [{ WIDGET_HTML, encodeState }] = await modules;
  assert.ok(Buffer.byteLength(WIDGET_HTML) <= 32768);
  assert.ok(deflateSync(WIDGET_HTML, { level: 9 }).length <= 4096);
  assert.ok(!WIDGET_HTML.includes("\0"));
  assert.doesNotMatch(WIDGET_HTML, /https?:|fetch\(|XMLHttpRequest|<input|<form|<iframe/);
  assert.ok(
    Buffer.byteLength(encodeState({ r: 1, t: "Ž".repeat(2000), s: "downloading", p: 50, e: "x".repeat(500), n: "y".repeat(900) })) <= 1024,
  );

  const script = /<script>([\s\S]*)<\/script>/.exec(WIDGET_HTML)![1]!;
  const nodes: Record<string, any> = {};
  const document = {
    getElementById: (id: string) => (nodes[id] ??= { style: {}, textContent: "", addEventListener(_e: string, f: () => void) { this.click = f; } }),
  };
  const events: Record<string, () => void> = {};
  const requests: string[] = [];
  const widget = {
    chatData: JSON.stringify({ r: 2, t: "Dune", s: "downloading", p: 42, e: "5m" }),
    viewer: { id: 1 },
    isActive: true,
    isForward: false,
    onEvent: (name: string, handler: () => void) => { events[name] = handler; },
    request: async (data: string) => { requests.push(data); return { result: null }; },
    ready() {},
  };
  runInNewContext(script, { window: { TelegramWidget: widget }, document, setInterval: () => 0, JSON });
  assert.equal(nodes["t"].textContent, "Dune");
  assert.equal(nodes["s"].textContent, "Downloading");
  assert.equal(nodes["b"].style.width, "42%");
  assert.equal(nodes["m"].textContent, "42% · 5m left");
  nodes["r"].click();
  assert.deepEqual(requests, ["p"]);
  // Stale revisions are ignored; newer ones redraw; finished requests hide Refresh.
  widget.chatData = JSON.stringify({ r: 1, t: "Old", s: "approved" });
  events["chatDataChanged"]!();
  assert.equal(nodes["t"].textContent, "Dune");
  widget.chatData = JSON.stringify({ r: 3, t: "Dune", s: "available" });
  events["chatDataChanged"]!();
  assert.equal(nodes["s"].textContent, "Ready to watch");
  assert.equal(nodes["b"].style.width, "100%");
  assert.equal(nodes["r"].style.display, "none");
  // Outside Telegram (no TelegramWidget) the script must not throw.
  runInNewContext(script, { window: {}, document, setInterval: () => 0, JSON });
});

const poster = Buffer.from("fake-jpeg-bytes");
function fakeSeerr(title: string, status: () => number) {
  global.fetch = async (input) => {
    const url = String(input);
    if (url.includes("image.tmdb.org")) {
      assert.match(url, /\/w45\/poster\.jpg$/);
      return new Response(poster, { headers: { "content-type": "image/jpeg" } });
    }
    if (url.includes("/request/")) return Response.json({ ...request, status: status() });
    if (url.includes("radarr")) return Response.json([]);
    return Response.json({ title, status: "Released", releaseDate: "2000-01-01", posterPath: "/poster.jpg" });
  };
}

test("approval sends one widget with a poster; availability replaces it with a fresh one", async () => {
  const [, notifications, { accountStore }] = await modules;
  accountStore.set({ telegramUserId: 12, seerrUserId: 7, seerrUsername: "test", linkedAt: Date.now() });
  const { bot, of } = fakeBot();
  let status = 2;
  fakeSeerr("Dune", () => status);
  await notifications.handleWebhook({ notification_type: "MEDIA_APPROVED", request: { request_id: "71" } }, bot);
  assert.equal(of("sendMessage").length, 0);
  const sent = of("sendWidget")[0]!.args;
  assert.equal(sent.chat_id, 12);
  assert.equal(sent.allow_queries, true);
  assert.match(sent.caption, /Dune/);
  assert.ok(sent.html.includes(`<img src="data:image/jpeg;base64,${poster.toString("base64")}"`));
  assert.ok(deflateSync(sent.html, { level: 9 }).length <= 4096);
  assert.equal(sent.reply_markup.inline_keyboard[0][0].web_app.url, "https://teleseerr.invalid/movie/10");
  assert.deepEqual(JSON.parse(sent.chat_data), { r: 1, t: "Dune", s: "approved" });

  status = 5;
  await notifications.handleWebhook({ notification_type: "MEDIA_AVAILABLE", request: { request_id: "71" } }, bot);
  assert.equal(of("sendMessage").length, 0);
  assert.equal(of("editMessageWidgetData").length, 0);
  const fresh = of("sendWidget")[1]!.args;
  assert.match(fresh.caption, /now available/);
  assert.ok(fresh.message_effect_id);
  assert.ok(fresh.html.includes("<img"));
  assert.equal(fresh.reply_markup.inline_keyboard[0][0].style, "success");
  assert.deepEqual(JSON.parse(fresh.chat_data), { r: 2, t: "Dune", s: "available" });
  assert.deepEqual(of("deleteMessage")[0]!.args, { chat_id: 12, message_id: 501 });
});

test("an undeletable old widget is marked available in place", async () => {
  const [, notifications] = await modules;
  const { bot, of } = fakeBot({ firstMessageId: 600, rejectDelete: true });
  let status = 2;
  fakeSeerr("Alien", () => status);
  await notifications.handleWebhook({ notification_type: "MEDIA_APPROVED", request: { request_id: "73" } }, bot);
  status = 5;
  await notifications.handleWebhook({ notification_type: "MEDIA_AVAILABLE", request: { request_id: "73" } }, bot);
  assert.equal(of("sendWidget").length, 2);
  const edit = of("editMessageWidgetData")[0]!.args;
  assert.equal(edit.message_id, 600);
  assert.equal(JSON.parse(edit.chat_data).s, "available");
});

test("a rejected widget falls back to the plain approval message", async () => {
  const [, notifications] = await modules;
  const { bot, of } = fakeBot({ rejectWidget: true });
  global.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/request/")) return Response.json(request);
    if (url.includes("radarr")) return Response.json([]);
    return Response.json({ title: "Arrival", status: "Released", releaseDate: "2000-01-01" });
  };
  await notifications.handleWebhook({ notification_type: "MEDIA_APPROVED", request: { request_id: "72" } }, bot);
  assert.equal(of("sendWidget").length, 1);
  assert.equal(of("sendMessage").length, 1);
  assert.match(of("sendMessage")[0]!.args.text, /Arrival/);
});

test("widget queries are always answered; only the owner's refresh reads progress and edits state", async () => {
  const [widgets] = await modules;
  const { bot, of } = fakeBot({ firstMessageId: 900 });
  await widgets.sendRequestWidget(bot, { requestId: 80, userId: 12, type: "movie", tmdbId: 10 }, "Heat", "approved", "Heat approved");
  const messageId = 900;
  let upstream = 0;
  global.fetch = async (input) => {
    const url = String(input);
    upstream++;
    if (url.includes("/request/")) return Response.json(request);
    if (url.includes("/queue"))
      return Response.json({ totalRecords: 1, records: [{ title: "Heat.1995", status: "downloading", trackedDownloadState: "downloading", trackedDownloadStatus: "ok", size: 1000, sizeleft: 250, timeleft: "00:05:00", movie: { tmdbId: 10 } }] });
    return Response.json([]);
  };
  const query = (id: string, from: number, data = "p") => ({ widget_query: { id, from: { id: from }, chat: { id: 12 }, message_id: messageId, data } });
  assert.equal(await widgets.handleWidgetQuery(bot, { message: {} }), false);
  assert.equal(await widgets.handleWidgetQuery(bot, query("q1", 99)), true);
  assert.equal(await widgets.handleWidgetQuery(bot, query("q2", 12, "unknown")), true);
  assert.equal(upstream, 0);
  assert.equal(of("editMessageWidgetData").length, 0);
  assert.equal(await widgets.handleWidgetQuery(bot, query("q3", 12)), true);
  const state = JSON.parse(of("editMessageWidgetData")[0]!.args.chat_data);
  assert.equal(state.s, "downloading");
  assert.equal(state.p, 75);
  assert.equal(state.r, 2);
  // Throttled: an immediate second refresh is answered without another upstream read.
  const before = upstream;
  await widgets.handleWidgetQuery(bot, query("q4", 12));
  assert.equal(upstream, before);
  assert.deepEqual(of("answerWidgetQuery").map((call) => call.args.widget_query_id), ["q1", "q2", "q3", "q4"]);
});
