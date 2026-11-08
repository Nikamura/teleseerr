import { test, after } from "node:test";
import assert from "node:assert/strict";
Object.assign(process.env, {
  TELEGRAM_BOT_TOKEN: "dummy",
  SEERR_URL: "https://seerr.invalid",
  SEERR_API_KEY: "dummy",
  TELESEERR_ADMIN_USER_ID: "1",
  TELESEERR_SONARR_URL: "https://sonarr.invalid",
  TELESEERR_SONARR_API_KEY: "dummy",
  LOG_LEVEL: "silent",
});
const originalFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = originalFetch;
});
test("completed transfers use fresh library files, retain import failures, and never show ETA zero", async () => {
  const { getTvProgress } = await import("../src/arr/client.js");
  const base = {
    title: "Season pack",
    size: 100,
    sizeleft: 0,
    timeleft: "00:00:00",
    status: "completed",
    trackedDownloadState: "downloadFinished",
    trackedDownloadStatus: "ok",
    seriesId: 4,
    series: { id: 4, tmdbId: 1421, tvdbId: 123 },
  };
  const rows = [
    { ...base, id: 1, episodeId: 1 },
    { ...base, id: 2, episodeId: 2 },
    { ...base, id: 3, episodeId: 3, trackedDownloadStatus: "warning" },
    { ...base, id: 4, episodeId: 4, status: "failed", trackedDownloadState: "failedPending" },
    { ...base, id: 5, episodeId: 5, status: "downloading", sizeleft: 50, timeleft: "00:01:00" },
  ];
  let imported = false,
    failLookup = false,
    queueReads = 0;
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.pathname.endsWith("/queue")) {
      queueReads++;
      return new Response(JSON.stringify({ records: rows, totalRecords: rows.length }));
    }
    assert.equal(u.pathname, "/api/v3/episode");
    assert.equal(u.searchParams.get("seriesId"), "4");
    if (failLookup) return new Response("outage", { status: 503 });
    return new Response(
      JSON.stringify([1, 2, 5].map((id) => ({ id, seriesId: 4, hasFile: id !== 2 || imported }))),
    );
  };
  let result = await getTvProgress(1421);
  assert.deepEqual(
    result.items.map((i) => i.status),
    ["available", "importing", "stalled", "failed", "downloading"],
  );
  assert.ok(result.items.slice(0, 4).every((i) => i.eta === null));
  assert.equal(result.items[4]?.eta, "1m 0s");
  imported = true;
  result = await getTvProgress(1421);
  assert.equal(
    result.items[1]?.status,
    "available",
    "file lookup must refresh despite cached queue",
  );
  assert.equal(queueReads, 1);
  failLookup = true;
  result = await getTvProgress(1421);
  assert.equal(result.items[0]?.status, "importing", "availability requires file confirmation");
});

test("progress rendering removes finished bars and ETA, including mixed season packs", async () => {
  const { readFileSync } = await import("node:fs");
  const { runInNewContext } = await import("node:vm");
  const source = readFileSync("web/detail.js", "utf8");
  const render = source.slice(
    source.indexOf("function renderProgressSection"),
    source.indexOf("function startProgressPolling"),
  );
  const html = runInNewContext(render + `\nrenderProgressSection(progress, 'tv')`, {
    escHtml: (s: string) => s,
    progress: {
      available: true,
      isSeasonPack: true,
      items: ["available", "importing", "failed"].map((status, index) => ({
        status,
        percent: 100,
        eta: "0s",
        episode: { season: 6, episode: index + 1, title: "Episode" },
      })),
    },
  });
  for (const text of ["✓ Available", "Preparing for playback", "Needs attention", "S06E03"])
    assert.ok(html.includes(text));
  assert.equal(html.includes("100%"), false);
  assert.equal(html.includes("ETA:"), false);
  assert.equal(html.includes("download-bar-track"), false);
});
