import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

test("live status works independently of a stale or broken scheduled observation and can retry offline failures", async () => {
  const nodes = Object.fromEntries(["state", "detail", "checked", "retry", "background", "other-services"].map(id => [id, { textContent: "", dataset: {} as Record<string, string>, disabled: false, hidden: false, addEventListener: (_: string, callback: () => void) => { if (id === "retry") retry = callback; } }]));
  let retry: () => void = () => {};
  let online = true; let brokenSnapshot = false;
  const settle = () => new Promise(resolve => setImmediate(resolve));
  runInNewContext(readFileSync("status/status.js", "utf8"), {
    document: { getElementById: (id: string) => nodes[id], addEventListener: () => {} },
    setInterval: () => {}, AbortSignal, Date, performance,
    fetch: async (url: string, options: RequestInit) => {
      if (url.startsWith("https:")) {
        assert.equal(options.credentials, "omit");
        if (!online) throw Error("offline");
        return { ok: true, json: async () => ({ status: "ok" }) };
      }
      if (brokenSnapshot) throw Error("bad background observation");
      return { ok: true, json: async () => ({ checkedAt: new Date(Date.now() - 7200000).toISOString(), services: [{ name: "Teleseerr", available: true }] }) };
    },
  });
  await settle();
  assert.equal(nodes.state!.textContent, "Online");
  assert.match(nodes.background!.textContent, /monitor is delayed/);
  online = false; retry(); await settle();
  assert.equal(nodes.state!.textContent, "Connection problem");
  assert.match(nodes.detail!.textContent, /doesn’t confirm a server outage/);
  assert.equal(nodes.retry!.disabled, false);
  online = true; brokenSnapshot = true; retry(); await settle();
  assert.equal(nodes.state!.textContent, "Online");
  assert.match(nodes.background!.textContent, /monitor is unavailable/);
});
