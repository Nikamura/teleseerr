import { test, after } from "node:test";
import assert from "node:assert/strict";
Object.assign(process.env, {
  TELEGRAM_BOT_TOKEN: "dummy",
  SEERR_URL: "https://seerr.invalid",
  SEERR_API_KEY: "dummy",
  TELESEERR_ADMIN_USER_ID: "1",
  TELESEERR_QBITTORRENT_URL: "https://bound.invalid:443",
  TELESEERR_QBITTORRENT_USERNAME: "operator",
  TELESEERR_QBITTORRENT_PASSWORD: "host-secret",
  LOG_LEVEL: "silent",
});
const original = globalThis.fetch;
after(() => {
  globalThis.fetch = original;
});
test("explicit torrent credentials bind to the exact configured client URL", async () => {
  const { torrentClient } = await import("../src/arr/torrent.js");
  let host = "other.invalid";
  let logins = 0;
  const instance = {
    name: "radarr",
    url: "https://radarr.invalid",
    type: "radarr" as const,
    apiKey: "dummy",
  };
  const item = {
    id: 1,
    downloadId: "b".repeat(40),
    title: "Movie",
    size: 10,
    sizeleft: 5,
    status: "downloading",
  };
  globalThis.fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/downloadclient"))
      return new Response(
        JSON.stringify([
          {
            id: 3,
            enable: true,
            implementation: "QBittorrent",
            fields: [
              { name: "host", value: host },
              { name: "port", value: 443 },
              { name: "useSsl", value: true },
              { name: "password", value: "********" },
            ],
          },
        ]),
      );
    if (path.endsWith("/login")) {
      logins++;
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get("password"), "host-secret");
      return new Response(null, {
        status: 204,
        headers: { "set-cookie": "QBT_SID_443=private; HttpOnly" },
      });
    }
    return new Response(JSON.stringify([{ hash: item.downloadId, priority: 3 }]));
  };
  await assert.rejects(() => torrentClient(instance, item), /redacted/);
  assert.equal(logins, 0);
  host = "bound.invalid";
  await torrentClient(instance, item);
  assert.equal(logins, 1);
  await torrentClient(instance, item);
  assert.equal(logins, 1);
});
