import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Bot } from "grammy";
import type { RouteContext } from "../src/http.js";

const dir = mkdtempSync(join(tmpdir(), "teleseerr-ignored-"));
Object.assign(process.env, { TELEGRAM_BOT_TOKEN: "dummy", SEERR_URL: "https://seerr.invalid", SEERR_API_KEY: "dummy", TELESEERR_ADMIN_USER_ID: "1", TELESEERR_DATA_DIR: dir, LOG_LEVEL: "silent" });
writeFileSync(join(dir, "ignored.json"), "[42]");
after(() => rmSync(dir, { recursive: true, force: true }));

test("legacy ignored IDs remain blocked and can gain profile details", async () => {
  const { pendingStore } = await import("../src/stores.js");
  assert.deepEqual(pendingStore.getIgnoredUsers(), [{ telegramUserId: 42 }]);
  assert.equal(pendingStore.add({telegramUserId: 42, username: "existing", firstName: "Existing", requestedAt: 1}), false);
  assert.equal(pendingStore.getIgnoredUsers()[0]?.username, "existing");
  assert.deepEqual(pendingStore.getAll(), []);
});

test("ignore preserves username and name, restore removes saved details", async () => {
  const { pendingStore } = await import("../src/stores.js");
  pendingStore.add({telegramUserId: 77, username: "example", firstName: "Example", requestedAt: 1});
  pendingStore.ignore(77);
  assert.equal(pendingStore.get(77), undefined);
  assert.equal(pendingStore.getIgnoredUsers().find(user => user.telegramUserId === 77)?.username, "example");
  assert.equal(JSON.parse(readFileSync(join(dir, "ignored-profiles.json"), "utf8"))["77"].firstName, "Example");
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "ignored.json"), "utf8")), [42,77]);
  pendingStore.unignore(77);
  pendingStore.setIgnoredProfile({telegramUserId: 77, username: "late-lookup"});
  assert.equal(pendingStore.getIgnoredUsers().some(user => user.telegramUserId === 77), false);
  assert.equal(JSON.parse(readFileSync(join(dir, "ignored-profiles.json"), "utf8"))["77"], undefined);
});

test("unavailable legacy accounts do not block lookup of later ignored users", async () => {
  const { pendingStore } = await import("../src/stores.js");
  const { handleAdminIgnored, setAdminBotInstance } = await import("../src/routes/admin.js");
  for (let id = 100; id < 106; id++) pendingStore.ignore(id);
  const attempted: number[] = [];
  setAdminBotInstance({ api: { getChat: async (id: number) => {
    attempted.push(id);
    if (id < 104) throw new Error("account unavailable");
    return { type: "private", first_name: "Recovered", username: `user${id}` };
  } } } as unknown as Bot);
  const context = { url: new URL("http://local/api/admin/ignored?details=1"), res: { writeHead() {}, end() {} } } as unknown as RouteContext;
  await handleAdminIgnored(context);
  await handleAdminIgnored(context);
  assert.deepEqual(attempted, [100, 101, 102, 103, 104, 105]);
  assert.equal(pendingStore.getIgnoredUsers().find(user => user.telegramUserId === 105)?.username, "user105");
});
