import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { Admission } from "../src/admission.js";
import { serviceUrl } from "../src/transport.js";

Object.assign(process.env, {
  TELEGRAM_BOT_TOKEN: "dummy-test-token",
  SEERR_URL: "https://seerr.invalid",
  SEERR_API_KEY: "dummy",
  TELESEERR_ADMIN_USER_ID: "1",
});
const auth = import("../src/auth.js");
const webhook = import("../src/webhook-event.js");

function signed(date: string | undefined, login = false, userId = 7): string {
  const values: Record<string, string> = login
    ? { id: String(userId), first_name: "Test" }
    : { user: JSON.stringify({ id: userId }) };
  if (date !== undefined) values.auth_date = date;
  const data = Object.entries(values)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const key = login
    ? createHash("sha256").update("dummy-test-token").digest()
    : createHmac("sha256", "WebAppData").update("dummy-test-token").digest();
  values.hash = createHmac("sha256", key).update(data).digest("hex");
  return login ? JSON.stringify(values) : new URLSearchParams(values).toString();
}

test("signed Mini App credentials expire and invalid timestamps/identities fail closed", async () => {
  const { authenticate } = await auth;
  const now = Math.floor(Date.now() / 1000);
  const check = (data: string) =>
    authenticate({ headers: { "x-telegram-init-data": data } } as unknown as IncomingMessage).valid;
  assert(check(signed(String(now))));
  assert(check(signed(String(now + 30))));
  for (const date of [
    undefined,
    "",
    "NaN",
    "Infinity",
    "1.5",
    String(now - 86401),
    String(now + 120),
  ])
    assert.equal(check(signed(date)), false, String(date));
  assert.equal(check(signed(String(now), false, -1)), false);
  assert.equal(check(signed(String(now)) + "&auth_date=" + now), false);
  assert.equal(
    check(signed(String(now)).replace(/hash=[a-f0-9]+/, "hash=" + "é".repeat(64))),
    false,
  );
});

test("Login Widget rejects future and expired signed timestamps", async () => {
  const { authenticate } = await auth;
  const now = Math.floor(Date.now() / 1000);
  const check = (date: string | undefined) =>
    authenticate({
      headers: { "x-telegram-login-data": signed(date, true) },
    } as unknown as IncomingMessage).valid;
  assert(check(String(now)));
  for (const date of [undefined, "Infinity", String(now + 120), String(now - 30 * 86400 - 1)])
    assert.equal(check(date), false);
});

test("admission bounds per-user and global concurrency and recovers after release", () => {
  const gate = new Admission(20, 1, 3, 2);
  const a = gate.acquire("a");
  const b = gate.acquire("a");
  assert(a && b);
  assert.equal(gate.acquire("a"), null);
  const c = gate.acquire("b");
  assert(c);
  assert.equal(gate.acquire("c"), null);
  a();
  a();
  assert(gate.acquire("c"));
  assert.equal(gate.acquire("d"), null);
});

test("burst limits apply even when each request finishes immediately", () => {
  let now = 0;
  const gate = new Admission(2, 1, 8, 2, () => now);
  gate.acquire("a")?.();
  gate.acquire("a")?.();
  assert.equal(gate.acquire("a"), null);
  now = 1000;
  assert(gate.acquire("a"));
});

test("service transport requires HTTPS or deliberate HTTP opt-in and rejects credential URLs", () => {
  assert.equal(
    serviceUrl("https://seerr.example/api/", "test", false),
    "https://seerr.example/api",
  );
  assert.throws(() => serviceUrl("http://seerr:5055", "test", false));
  assert.equal(serviceUrl("http://seerr:5055", "test", true), "http://seerr:5055");
  for (const url of [
    "ftp://host",
    "https://user:pass@host",
    "https://host?key=secret",
    "https://host/#x",
  ])
    assert.throws(() => serviceUrl(url, "test", true));
});

test("webhooks require strict request IDs and status consistent with Seerr, including 4K", async () => {
  const { webhookEvent, matchesRequest } = await webhook;
  assert.deepEqual(
    webhookEvent({ notification_type: "MEDIA_FAILED", request: { request_id: "7" } }),
    { type: "MEDIA_FAILED", requestId: 7 },
  );
  for (const id of [true, [], -1, 0, "1e2", "7/other"])
    assert.throws(() =>
      webhookEvent({ notification_type: "MEDIA_FAILED", request: { request_id: id } }),
    );
  const request = {
    requestedBy: { id: 1 },
    type: "movie",
    is4k: true,
    status: 2,
    media: { tmdbId: 10, status: 5, status4k: 3 },
  };
  assert.equal(matchesRequest("MEDIA_AVAILABLE", request), false);
  assert.equal(matchesRequest("MEDIA_DECLINED", request), false);
  assert.equal(matchesRequest("MEDIA_FAILED", request), false);
  assert.equal(matchesRequest("MEDIA_APPROVED", request), true);
  assert.equal(
    matchesRequest("MEDIA_AVAILABLE", { ...request, media: { ...request.media, status4k: 5 } }),
    true,
  );
});
