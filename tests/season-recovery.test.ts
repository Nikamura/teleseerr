import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { RouteContext } from "../src/http.js";
const dir = mkdtempSync(join(tmpdir(), "teleseerr-episodes-"));
Object.assign(process.env, {
  TELEGRAM_BOT_TOKEN: "dummy",
  SEERR_URL: "https://seerr.invalid",
  SEERR_API_KEY: "dummy",
  TELESEERR_ADMIN_USER_ID: "1",
  TELESEERR_DATA_DIR: dir,
  TELESEERR_SONARR_URL: "https://sonarr.invalid",
  TELESEERR_SONARR_API_KEY: "dummy",
  LOG_LEVEL: "silent",
});
const originalFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = originalFetch;
  rmSync(dir, { recursive: true, force: true });
});
const series = { id: 523, tmdbId: 292108, tvdbId: 466276, monitored: true };
const missing = {
  id: 40548,
  seriesId: 523,
  seasonNumber: 1,
  episodeNumber: 6,
  title: "Episode 6",
  airDateUtc: "2026-08-21T20:30:00Z",
  hasFile: false,
  monitored: true,
};
const release = {
  guid: "safe",
  indexerId: 1,
  title: "Ann.Droid.S01E06.1080p.WEB",
  size: 100,
  protocol: "torrent",
  downloadAllowed: true,
  rejections: [],
  seasonNumber: 1,
  episodeNumbers: [6],
};
let episode = { ...missing };
let entries: any[] = [];
let releases: any[] = [release];
let calls: { url: string; method: string; body?: unknown }[] = [];
let nextUser = 100;
let extra: any[] = [];
let failCommand = false;
let importDuringRecovery = false;
let commandStatus = "queued";
beforeEach(() => {
  episode = { ...missing };
  entries = [];
  releases = [release];
  calls = [];
  extra = [];
  failCommand = false;
  importDuringRecovery = false;
  commandStatus = "completed";
  rmSync(join(dir, "download-switches.json"), { force: true });
  globalThis.fetch = async (url, options) => {
    const u = new URL(String(url));
    const method = options?.method ?? "GET";
    calls.push({
      url: u.pathname + u.search,
      method,
      body: options?.body ? JSON.parse(String(options.body)) : undefined,
    });
    let value: unknown;
    if (u.hostname === "seerr.invalid") value = { id: 292108, externalIds: { tvdbId: 466276 } };
    else if (u.pathname === "/api/v3/series") value = [series];
    else if (u.pathname === "/api/v3/episode/40548") value = episode;
    else if (u.pathname === "/api/v3/episode") value = [episode, ...extra];
    else if (u.pathname === "/api/v3/seasonpass") value = {};
    else if (u.pathname === "/api/v3/episode/monitor") {
      episode.monitored = true;
      if (importDuringRecovery) episode.hasFile = true;
      value = {};
    } else if (u.pathname === "/api/v3/command") {
      if (failCommand) throw new Error("timeout");
      value = { id: 123 };
    } else if (u.pathname === "/api/v3/command/123") value = { status: commandStatus };
    else if (u.pathname === "/api/v3/queue")
      value = { records: entries, totalRecords: entries.length };
    else if (u.pathname === "/api/v3/release") value = method === "GET" ? releases : {};
    else throw new Error(`Unexpected path ${u.pathname}`);
    return new Response(JSON.stringify(value));
  };
});
function context(
  user: number,
  body: unknown = {},
  params: Record<string, string> = {},
): { ctx: RouteContext; result: () => any } {
  let output: any;
  return {
    ctx: {
      auth: { valid: true, userId: user },
      params,
      req: Readable.from([Buffer.from(JSON.stringify(body))]),
      res: {
        writeHead() {},
        end(s: string) {
          output = JSON.parse(s);
        },
      },
    } as unknown as RouteContext,
    result: () => output,
  };
}

async function recover(body: any = {}, user = 1) {
  const { handleSeasonRecovery } = await import("../src/routes/downloads.js");
  const c = context(user, {
    instance: "sonarr",
    tmdbId: 292108,
    season: 1,
    confirmed: true,
    ...body,
  });
  await handleSeasonRecovery(c.ctx);
  return c.result();
}
test("recovery repairs only missing aired episodes and starts an exact episode search", async () => {
  commandStatus = "queued";
  episode.monitored = false;
  extra = [
    { ...missing, id: 8, hasFile: true, monitored: false },
    { ...missing, id: 9, airDateUtc: "2099-01-01", monitored: false },
    { ...missing, id: 10, seasonNumber: 2, monitored: false },
    { ...missing, id: 11, airDateUtc: undefined, monitored: false },
  ];
  const result = await recover();
  assert.equal(result.count, 1);
  const mutations = calls.filter((c) => c.method !== "GET");
  assert.deepEqual(
    mutations.map((c) => [c.method, c.url, c.body]),
    [
      [
        "POST",
        "/api/v3/seasonpass",
        { series: [{ id: 523, monitored: true, seasons: [{ seasonNumber: 1, monitored: true }] }] },
      ],
      ["PUT", "/api/v3/episode/monitor", { episodeIds: [40548], monitored: true }],
      ["POST", "/api/v3/command", { name: "EpisodeSearch", episodeIds: [40548] }],
    ],
  );
  const { handleDownloads } = await import("../src/routes/downloads.js");
  const c = context(1, {}, { type: "tv", id: "292108" });
  await handleDownloads(c.ctx);
  assert.deepEqual(c.result().libraries[0].searches, [{ season: 1, status: "queued" }]);
  await assert.rejects(recover(), /already running/);
  commandStatus = "completed";
});
test("permission, confirmation, service type and invalid season block writes", async () => {
  await assert.rejects(recover({}, 888), /permission/);
  for (const body of [
    { confirmed: false },
    { season: -1 },
    { season: 1.5 },
    { tmdbId: "292108" },
    { instance: "unknown" },
  ])
    await assert.rejects(recover(body));
  assert.equal(
    calls.some((c) => c.method !== "GET"),
    false,
  );
});
test("available, unaired, unknown and queued episodes cannot trigger recovery", async () => {
  episode.hasFile = true;
  await assert.rejects(recover(), /No missing/);
  episode.hasFile = false;
  episode.airDateUtc = "2099-01-01";
  await assert.rejects(recover(), /No missing/);
  episode.airDateUtc = undefined as any;
  await assert.rejects(recover(), /No missing/);
  episode.airDateUtc = missing.airDateUtc;
  entries = [{ seriesId: 523, episodeId: 40548, sizeleft: 5 }];
  await assert.rejects(recover(), /No missing/);
  assert.equal(
    calls.some((c) => c.method !== "GET"),
    false,
  );
});
test("ambiguous command failure reports partial state and reserves cooldown", async () => {
  failCommand = true;
  await assert.rejects(recover(), /Monitoring may have changed/);
  assert.ok(calls.some((c) => c.url === "/api/v3/episode/monitor"));
  failCommand = false;
  await assert.rejects(recover(), /recently attempted/);
  assert.equal(calls.filter((c) => c.url === "/api/v3/command").length, 1);
});

test("episode imported during monitoring is excluded from the search", async () => {
  importDuringRecovery = true;
  const result = await recover();
  assert.equal(result.count, 0);
  assert.equal(
    calls.some((c) => c.url === "/api/v3/command"),
    false,
  );
});

test("single episode recovery excludes other missing episodes in the same season", async () => {
  episode.monitored = false;
  extra = [{ ...missing, id: 8, episodeNumber: 7, monitored: false }];
  const result = await recover({ episodeId: 40548 });
  assert.equal(result.count, 1);
  assert.deepEqual(calls.find((c) => c.url === "/api/v3/episode/monitor")?.body, {
    episodeIds: [40548],
    monitored: true,
  });
  assert.deepEqual(calls.find((c) => c.url === "/api/v3/command")?.body, {
    name: "EpisodeSearch",
    episodeIds: [40548],
  });
  assert.equal(extra[0].monitored, false);
});

test("invalid, foreign, unavailable and wrong-season episode selections cannot broaden recovery", async () => {
  for (const episodeId of [null, "40548", 0, -1, 1.5, 999]) {
    await assert.rejects(recover({ episodeId }));
  }
  await assert.rejects(recover({ episodeId: 40548, season: 2 }), /No missing/);
  episode.seriesId = 999;
  await assert.rejects(recover({ episodeId: 40548 }), /No missing/);
  assert.equal(
    calls.some((c) => c.method !== "GET"),
    false,
  );
});
