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
