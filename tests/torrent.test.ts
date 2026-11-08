import { test, after } from "node:test";
import assert from "node:assert/strict";
Object.assign(process.env, {
  TELEGRAM_BOT_TOKEN: "dummy",
  SEERR_URL: "https://seerr.invalid",
  SEERR_API_KEY: "dummy",
  TELESEERR_ADMIN_USER_ID: "1",
  LOG_LEVEL: "silent",
});
const originalFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = originalFetch;
});
const instance = {
  name: "radarr",
  type: "radarr" as const,
  url: "https://radarr.invalid",
  apiKey: "key",
};
const item = {
  id: 1,
  movieId: 8,
  downloadId: "a".repeat(40),
  downloadClientId: 3,
  title: "Movie",
  size: 10,
  sizeleft: 8,
  status: "downloading",
};
test("priority targets only the mapped hash, requires enabled queueing and verifies the resulting priority", async () => {
  const { torrentClient } = await import("../src/arr/torrent.js");
  let enabled = false;
  let promoted = false;
  let mutationBody = "";
  globalThis.fetch = async (url, init) => {
    const p = new URL(String(url)).pathname;
    let data: any;
    if (p.endsWith("/downloadclient"))
      data = [
        {
          id: 3,
          enable: true,
          implementation: "QBittorrent",
          fields: [
            { name: "host", value: "torrent.invalid" },
            { name: "port", value: 443 },
            { name: "useSsl", value: true },
            { name: "username", value: "test" },
            { name: "password", value: "secret" },
          ],
        },
      ];
    else if (p.endsWith("/login"))
      return new Response("Ok.", { headers: { "set-cookie": "SID=private-cookie; HttpOnly" } });
    else if (p.endsWith("/info"))
      data = [{ hash: item.downloadId, priority: promoted ? 1 : 5, state: "downloading" }];
    else if (p.endsWith("/preferences")) data = { queueing_enabled: enabled };
    else if (p.endsWith("/topPrio")) {
      promoted = true;
      mutationBody = String(init?.body);
      return new Response("");
    } else throw Error(p);
    return new Response(JSON.stringify(data));
  };
  let client = await torrentClient(instance, item);
  await assert.rejects(() => client.prioritize(), /queueing is disabled/);
  assert.equal(promoted, false);
  enabled = true;
  client = await torrentClient(instance, item);
  await client.prioritize();
  assert.equal(mutationBody, `hashes=${item.downloadId}`);
  assert.ok(!JSON.stringify(client.info).includes("secret"));
});
test("unmapped or malformed hashes do not mutate a torrent client", async () => {
  const { torrentClient } = await import("../src/arr/torrent.js");
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response("[]");
  };
  await assert.rejects(() => torrentClient(instance, { ...item, downloadId: "not-a-hash" }));
  assert.equal(calls, 0);
});
