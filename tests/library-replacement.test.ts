import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { RouteContext } from "../src/http.js";
const dir = mkdtempSync(join(tmpdir(), "teleseerr-library-"));
Object.assign(process.env, {
  TELEGRAM_BOT_TOKEN: "dummy",
  SEERR_URL: "https://seerr.invalid",
  SEERR_API_KEY: "dummy",
  TELESEERR_ADMIN_USER_ID: "1",
  TELESEERR_DATA_DIR: dir,
  TELESEERR_RADARR_URL: "https://radarr.invalid",
  TELESEERR_RADARR_API_KEY: "dummy",
  TELESEERR_SONARR_URL: "https://sonarr.invalid",
  TELESEERR_SONARR_API_KEY: "dummy",
  LOG_LEVEL: "silent",
});
const originalFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = originalFetch;
  rmSync(dir, { recursive: true, force: true });
});
let user = 100;
let movieFile = 90;
let missing = false;
let active = false;
let posts: any[] = [];
const quality = { quality: { id: 7, name: "1080p" }, revision: { version: 1, real: 0 } };
const episodes = () =>
  [1, 2].map((id) => ({
    id,
    seriesId: 3,
    seasonNumber: 6,
    episodeNumber: id,
    hasFile: !(missing && id === 2),
    episodeFileId: 70,
    title: `Episode ${id}`,
    monitored: true,
  }));
beforeEach(() => {
  movieFile = 90;
  missing = false;
  active = false;
  posts = [];
  rmSync(join(dir, "download-switches.json"), { force: true });
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url));
    const p = u.pathname;
    if (init?.method && init.method !== "GET") {
      posts.push({ method: init.method, path: p, body: JSON.parse(String(init.body)) });
      return new Response("{}");
    }
    const isMovie = u.hostname === "radarr.invalid";
    let value: any;
    if (u.hostname === "seerr.invalid") value = { externalIds: { tvdbId: 99 } };
    else if (p.endsWith("/movie"))
      value = [
        {
          id: 8,
          tmdbId: 123,
          hasFile: true,
          movieFile: { id: movieFile, sceneName: "Old", quality, customFormatScore: 10 },
        },
      ];
    else if (p.endsWith("/series")) value = [{ id: 3, tmdbId: 1421, tvdbId: 99, monitored: true }];
    else if (p.endsWith("/episode")) value = episodes();
    else if (p.endsWith("/episodefile"))
      value = [{ id: 70, seriesId: 3, sceneName: "Old", quality, customFormatScore: 10 }];
    else if (p.endsWith("/queue"))
      value = {
        records: active
          ? [
              {
                id: 11,
                seriesId: 3,
                episodeId: 1,
                downloadId: "a".repeat(40),
                size: 100,
                sizeleft: 80,
                status: "downloading",
              },
            ]
          : [],
        totalRecords: active ? 1 : 0,
      };
    else if (p.endsWith("/release"))
      value = [
        {
          guid: "new",
          indexerId: 1,
          title: "New",
          size: 100,
          protocol: "torrent",
          quality,
          customFormatScore: 10,
          rejected: true,
          rejections: ["Existing file meets cutoff: 1080p"],
          downloadAllowed: true,
          ...(!isMovie ? { fullSeason: true, seasonNumber: 6, episodeNumbers: [1, 2] } : {}),
        },
      ];
    else throw Error(p);
    return new Response(JSON.stringify(value));
  };
});
function context(id: number, body: unknown) {
  let result: any;
  return {
    context: {
      auth: { userId: id, valid: true },
      req: Readable.from([Buffer.from(JSON.stringify(body))]),
      params: {},
      res: {
        writeHead() {},
        end(s: string) {
          result = JSON.parse(s);
        },
      },
    } as unknown as RouteContext,
    result: () => result,
  };
}
async function search(target: object) {
  const { accountStore } = await import("../src/stores.js");
  const { handleReleaseSearch } = await import("../src/routes/downloads.js");
  const id = user++;
  accountStore.set({
    telegramUserId: id,
    seerrUserId: id,
    seerrUsername: "tester",
    linkedAt: 1,
    manageDownloads: true,
  });
  const c = context(id, { ...target, replaceExisting: true });
  await handleReleaseSearch(c.context);
  return { user: id, ...c.result() };
}
test("movie replacement snapshots file identity, grabs only the mapped movie and never deletes", async () => {
  const { handleReleaseSwitch } = await import("../src/routes/downloads.js");
  const data = await search({ instance: "radarr", tmdbId: 123 });
  assert.deepEqual(data.releases[0].problems, []);
  await handleReleaseSwitch(
    context(data.user, { token: data.token, index: 0, confirmed: true }).context,
  );
  assert.deepEqual(posts, [
    { method: "POST", path: "/api/v3/release", body: { guid: "new", indexerId: 1, movieId: 8 } },
  ]);
});
test("changed movie file blocks stale replacement", async () => {
  const { handleReleaseSwitch } = await import("../src/routes/downloads.js");
  const data = await search({ instance: "radarr", tmdbId: 123 });
  movieFile++;
  await assert.rejects(
    () =>
      handleReleaseSwitch(
        context(data.user, { token: data.token, index: 0, confirmed: true }).context,
      ),
    /changed/,
  );
  assert.equal(posts.length, 0);
});
test("complete season replacement supports a shared multi-episode file and grabs the exact season", async () => {
  const { handleReleaseSwitch } = await import("../src/routes/downloads.js");
  const data = await search({ instance: "sonarr", tmdbId: 1421, episodeIds: [1, 2] });
  assert.equal(data.pack, true);
  assert.deepEqual(data.releases[0].problems, []);
  await handleReleaseSwitch(
    context(data.user, { token: data.token, index: 0, confirmed: true }).context,
  );
  assert.deepEqual(posts[0].body, { guid: "new", indexerId: 1, seriesId: 3, episodeIds: [1, 2] });
  assert.ok(posts.every((p) => p.method === "POST"));
});
test("partial seasons, missing files and active transfers cannot be batch-replaced", async () => {
  await assert.rejects(
    () => search({ instance: "sonarr", tmdbId: 1421, episodeIds: [1, 3] }),
    /complete season/,
  );
  missing = true;
  await assert.rejects(
    () => search({ instance: "sonarr", tmdbId: 1421, episodeIds: [1, 2] }),
    /complete season/,
  );
  missing = false;
  active = true;
  await assert.rejects(
    () => search({ instance: "sonarr", tmdbId: 1421, episodeIds: [1, 2] }),
    /active transfer/,
  );
  assert.equal(posts.length, 0);
});
