import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Bot } from "grammy";

const dir = mkdtempSync(join(tmpdir(), "teleseerr-notifications-"));
Object.assign(process.env, {
  TELESEERR_ALLOW_INSECURE_HTTP: "true",
  TELEGRAM_BOT_TOKEN: "dummy",
  SEERR_URL: "http://seerr.invalid",
  SEERR_API_KEY: "dummy",
  TELESEERR_ADMIN_USER_ID: "1",
  TELESEERR_DATA_DIR: dir,
  TELESEERR_WEBHOOK_SECRET: "test-secret",
  TELESEERR_MINI_APP_URL: "https://teleseerr.invalid",
  TELESEERR_MAINTAINERR_URL: "http://maintainerr.invalid",
  LOG_LEVEL: "silent",
  TELESEERR_RADARR_URL: "http://radarr.invalid",
  TELESEERR_RADARR_API_KEY: "dummy",
  TELESEERR_RADARR_4K_URL: "http://radarr4k.invalid",
  TELESEERR_RADARR_4K_API_KEY: "dummy",
});
const originalFetch = global.fetch;
after(() => {
  global.fetch = originalFetch;
  rmSync(dir, { recursive: true, force: true });
});
const modules = Promise.all([
  import("../src/arr/availability.js"),
  import("../src/notifications.js"),
  import("../src/stores.js"),
]);
const request = {
  status: 2,
  requestedBy: { id: 7 },
  type: "movie",
  is4k: false,
  serverId: 1,
  media: { tmdbId: 10 },
};

test("webhook text cannot spoof a title and inconsistent events send no message", async () => {
  const [, notifications, { accountStore }] = await modules;
  accountStore.set({
    telegramUserId: 12,
    seerrUserId: 7,
    seerrUsername: "test",
    linkedAt: Date.now(),
  });
  const messages: string[] = [];
  const bot = {
    api: {
      sendMessage: async (_user: number, text: string) => {
        messages.push(text);
      },
    },
  } as unknown as Bot;
  global.fetch = async (input) =>
    String(input).includes("/request/")
      ? Response.json({ ...request, type: "tv" })
      : Response.json({ name: "Trusted title" });
  await notifications.handleWebhook(
    {
      notification_type: "MEDIA_AVAILABLE",
      request: { request_id: "101" },
      subject: "Fake download",
    },
    bot,
  );
  assert.equal(messages.length, 0);
  await notifications.handleWebhook(
    {
      notification_type: "MEDIA_APPROVED",
      request: { request_id: "101" },
      subject: "Visit malicious link",
    },
    bot,
  );
  assert.equal(messages.length, 1);
  assert(messages[0]?.includes("Trusted title"));
  assert(!messages[0]?.includes("malicious"));
});

test("failed request enrichment still delivers the local approval confirmation", async () => {
  const [, notifications] = await modules;
  const messages: string[] = [];
  const bot = {
    api: {
      sendMessage: async (_user: number, text: string) => {
        messages.push(text);
      },
    },
  } as unknown as Bot;
  global.fetch = async (input) => {
    if (String(input).includes("/request/")) throw new Error("Seerr timed out");
    return Response.json({ name: "Test show" });
  };
  notifications.sendAutoApproveNotification(bot, 12, "tv", 10, 90);
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(messages.length, 1);
  assert(messages[0]?.includes("queued for processing"));
});

test("4K approval checks only the 4K Radarr instance", async () => {
  const [{ waitingForRelease }] = await modules;
  const paths: string[] = [];
  global.fetch = async (input) => {
    const url = String(input);
    paths.push(url);
    return Response.json(
      url.includes("/service/radarr")
        ? [{ id: 2, is4k: true }]
        : [{ tmdbId: 10, isAvailable: false }],
    );
  };
  assert.equal(await waitingForRelease({ ...request, is4k: true, serverId: 2 }), true);
  assert(paths.some((url) => url.startsWith("http://radarr4k.invalid/")));
  assert(!paths.some((url) => url.startsWith("http://radarr.invalid/")));
});

test("mismatched movies never borrow another movie's availability", async () => {
  const [{ waitingForRelease }] = await modules;
  global.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/service/radarr")) return Response.json([{ id: 1, is4k: false }]);
    if (url.includes("/api/v3/movie")) return Response.json([{ tmdbId: 99, isAvailable: false }]);
    return Response.json({ status: "Released", releaseDate: "2000-01-01" });
  };
  assert.equal(await waitingForRelease(request), false);
});

test("ambiguous Radarr routing falls back without contacting a wrong instance", async () => {
  const [{ waitingForRelease }] = await modules;
  global.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/service/radarr"))
      return Response.json([
        { id: 1, is4k: false },
        { id: 3, is4k: false },
      ]);
    assert(!url.includes("/api/v3/movie"));
    return Response.json({ status: "In Production", releaseDate: "" });
  };
  assert.equal(await waitingForRelease(request), true);
});

test("webhook and local auto-approval share delivery; configured but absent webhook keeps local confirmation", async () => {
  const [, notifications, { accountStore }] = await modules;
  accountStore.set({
    telegramUserId: 12,
    seerrUserId: 7,
    seerrUsername: "test",
    linkedAt: Date.now(),
  });
  const messages: string[] = [];
  const bot = {
    api: {
      sendMessage: async (_user: number, text: string) => {
        messages.push(text);
      },
    },
  } as unknown as Bot;
  global.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/request/")) return Response.json({ ...request, type: "tv" });
    return Response.json({ name: "Test show" });
  };
  notifications.sendAutoApproveNotification(bot, 12, "tv", 10, 55);
  await notifications.handleWebhook(
    {
      notification_type: "MEDIA_AUTO_APPROVED",
      subject: "Test show",
      request: { request_id: "55" },
    },
    bot,
  );
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(messages.length, 1);
  assert(messages[0]?.includes("queued for processing"));
  notifications.sendAutoApproveNotification(bot, 12, "tv", 10, 56);
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(messages.length, 2);
});

test("available notification opens the title, celebrates, shows cleanup in local time and survives a rejected effect", async () => {
  const [, notifications] = await modules;
  const { GrammyError } = await import("grammy");
  const sent: { text: string; options: any }[] = [];
  let rejectEffect = true;
  const bot = {
    api: {
      sendMessage: async (_user: number, text: string, options: any) => {
        if (options.message_effect_id && rejectEffect)
          throw new GrammyError(
            "rejected",
            { ok: false, error_code: 400, description: "Bad Request: EFFECT_ID_INVALID" },
            "sendMessage",
            {},
          );
        sent.push({ text, options });
      },
    },
  } as unknown as Bot;
  const eligible = Date.now() + 30 * 86400_000;
  global.fetch = async (input) => {
    const url = String(input);
    if (url.includes("maintainerr"))
      return Response.json([
        {
          id: 1,
          type: "movie",
          isActive: true,
          arrAction: 0,
          deleteAfterDays: 30,
          media: [{ id: 1, tmdbId: 10, addDate: new Date(eligible - 30 * 86400_000).toISOString() }],
        },
      ]);
    if (url.includes("/request/")) return Response.json({ ...request, status: 5 });
    return Response.json({ title: "Test (movie)" });
  };
  const event = (id: string) => ({ notification_type: "MEDIA_AVAILABLE", request: { request_id: id } });
  await notifications.handleWebhook(event("201"), bot);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.options.message_effect_id, undefined);
  const button = sent[0]!.options.reply_markup.inline_keyboard[0][0];
  assert.equal(button.web_app.url, "https://teleseerr.invalid/movie/10");
  assert.equal(button.style, "success");
  assert.match(sent[0]!.text, /Test \\\(movie\\\)/);
  assert(
    sent[0]!.text.includes(`](tg://time?unix=${Math.floor(eligible / 1000)}&format=D)`),
    sent[0]!.text,
  );
  rejectEffect = false;
  await notifications.handleWebhook(event("202"), bot);
  assert.equal(sent[1]!.options.message_effect_id, "5046509860389126442");
});

test("approval waiting for release shows the release day as a date entity with escaped fallback text", async () => {
  const [, notifications] = await modules;
  const sent: { text: string; options: any }[] = [];
  const bot = {
    api: {
      sendMessage: async (_user: number, text: string, options: any) => {
        sent.push({ text, options });
      },
    },
  } as unknown as Bot;
  global.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/request/")) return Response.json(request);
    if (url.includes("/service/radarr")) return Response.json([]);
    return Response.json({ title: "Future film", status: "Post Production", releaseDate: "2999-12-25" });
  };
  await notifications.handleWebhook(
    { notification_type: "MEDIA_APPROVED", request: { request_id: "301" } },
    bot,
  );
  const noon = Date.UTC(2999, 11, 25, 12) / 1000;
  assert.equal(sent.length, 1);
  assert(sent[0]!.text.includes(`![25 Dec 2999](tg://time?unix=${noon}&format=D)`), sent[0]!.text);
  assert.equal(sent[0]!.options.reply_markup.inline_keyboard[0][0].style, undefined);
  assert.equal(notifications.dateTime(Date.UTC(2026, 0, 2, 3, 4), "dt"), "![2 Jan 2026 03:04 UTC](tg://time?unix=1767323040&format=dt)");
});
