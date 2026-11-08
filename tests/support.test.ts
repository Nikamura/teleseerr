import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { RouteContext } from "../src/http.js";
const dir = mkdtempSync(join(tmpdir(), "teleseerr-support-"));
Object.assign(process.env, {
  TELEGRAM_BOT_TOKEN: "dummy",
  SEERR_URL: "https://seerr.invalid",
  SEERR_API_KEY: "dummy",
  TELESEERR_ADMIN_USER_ID: "1",
  TELESEERR_DATA_DIR: dir,
  TELESEERR_RADARR_URL: "https://radarr.invalid",
  TELESEERR_RADARR_API_KEY: "dummy",
  LOG_LEVEL: "silent",
});
const originalFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = originalFetch;
  rmSync(dir, { recursive: true, force: true });
});
function ctx(user: number, body: unknown): RouteContext {
  return {
    auth: { userId: user, valid: true },
    req: Readable.from([Buffer.from(JSON.stringify(body))]),
    params: {},
    res: { writeHead() {}, end() {} },
  } as unknown as RouteContext;
}
test("report ownership, deduplication, explicit resolution and imported-file follow-up", async () => {
  const s = await import("../src/support-store.js");
  const input = {
    owner: 42,
    type: "tv" as const,
    tmdbId: 1421,
    episodeId: 6,
    category: "playback",
    device: "TV",
    notes: "Won't play",
    fileIds: ["sonarr:12"],
  };
  const r = s.createReport(input);
  assert.equal(s.createReport(input).id, r.id);
  assert.equal(s.reports(99).length, 0);
  assert.equal(s.reports(1, true).length, 1);
  assert.throws(() => s.updateReport(r.id, 99, false, "resolved", ""));
  assert.throws(() => s.updateReport(r.id, 42, false, "investigating", ""));
  s.markReplacement(42, "tv", 1421, 6, ["sonarr:12"]);
  assert.equal(s.reports(42)[0]!.status, "open");
  s.markReplacement(42, "tv", 1421, 6, ["sonarr:13"]);
  assert.equal(s.reports(42)[0]!.status, "replacement_available");
  s.updateReport(r.id, 42, false, "resolved", "");
  assert.equal(s.reports(42)[0]!.status, "resolved");
});
test("persistent action cooldowns survive repeated calls and corrupted stores fail closed", async () => {
  const s = await import("../src/support-store.js");
  s.cooldown("test", 120);
  assert.throws(() => s.cooldown("test", 120));
  const path = join(dir, "support.json");
  const { readFileSync } = await import("node:fs");
  const backup = readFileSync(path);
  writeFileSync(path, "broken");
  assert.throws(() => s.cooldown("anything"));
  writeFileSync(path, backup);
});
test("diagnostic messages never reveal paths, URLs or credentials", async () => {
  const { safeProblem } = await import("../src/routes/support.js");
  for (const msg of [
    "Import failed /private/media/token.mkv https://tracker.invalid?apikey=secret",
    "Permission denied /mnt/private",
    "Disk full /media",
    "Unknown token secret",
  ]) {
    const safe = safeProblem(msg);
    assert.ok(!safe.includes("/"));
    assert.ok(!safe.includes("secret"));
  }
});
test("request edits require owner and pending status; approved cancellation cannot mutate", async () => {
  const { accountStore } = await import("../src/stores.js");
  const { handleRequestChange } = await import("../src/routes/support.js");
  accountStore.set({
    telegramUserId: 42,
    seerrUserId: 9,
    seerrUsername: "viewer",
    linkedAt: new Date().toISOString(),
  });
  let mutations = 0;
  let owner = 10;
  let status = 1;
  globalThis.fetch = async (_url, init) => {
    if (init?.method && init.method !== "GET") mutations++;
    return new Response(
      JSON.stringify({
        requestedBy: { id: owner },
        status,
        type: "tv",
        is4k: false,
        media: { tmdbId: 1421 },
      }),
    );
  };
  await assert.rejects(() =>
    handleRequestChange(ctx(42, { id: 5, action: "cancel", confirmed: true })),
  );
  owner = 9;
  status = 2;
  await assert.rejects(() =>
    handleRequestChange(ctx(42, { id: 5, action: "cancel", confirmed: true })),
  );
  assert.equal(mutations, 0);
});
test("import retry uses only fresh server-side path and rejects incomplete transfer", async () => {
  const { handleSupportAction } = await import("../src/routes/support.js");
  let remaining = 100;
  let payload: any;
  globalThis.fetch = async (url, init) => {
    const path = String(url);
    if (path.includes("queue?"))
      return new Response(
        JSON.stringify({
          totalRecords: 1,
          records: [
            {
              id: 72,
              downloadId: "a".repeat(40),
              movieId: 5,
              size: 100,
              sizeleft: remaining,
              outputPath: "/trusted/from/arr",
              trackedDownloadState: "importPending",
            },
          ],
        }),
      );
    payload = JSON.parse(String(init?.body));
    return new Response("{}");
  };
  await assert.rejects(() =>
    handleSupportAction(
      ctx(1, {
        instance: "radarr",
        queueId: 72,
        action: "retry-import",
        confirmed: true,
        path: "/attacker",
      }),
    ),
  );
  remaining = 0;
  await handleSupportAction(
    ctx(1, {
      instance: "radarr",
      queueId: 72,
      action: "retry-import",
      confirmed: true,
      path: "/attacker",
    }),
  );
  assert.equal(payload.path, "/trusted/from/arr");
  assert.equal(payload.name, "DownloadedMoviesScan");
});
test("a file imported in another library cannot advance a scoped report", async () => {
  const s = await import("../src/support-store.js");
  const r = s.createReport({
    owner: 88,
    type: "tv",
    tmdbId: 1421,
    instance: "sonarr4k",
    episodeId: 6,
    category: "audio",
    device: "TV",
    notes: "no English",
    fileIds: ["sonarr4k:12"],
  });
  s.markReplacement(88, "tv", 1421, 6, ["sonarr:13"]);
  assert.equal(s.reports(88)[0]!.status, "open");
  s.markReplacement(88, "tv", 1421, 6, ["sonarr4k:13"]);
  assert.equal(s.reports(88)[0]!.status, "replacement_available");
  assert.ok(r.id);
});
test("failed request retry uses the owner's Seerr identity, available requests cannot be retried", async () => {
  const { handleRequestChange } = await import("../src/routes/support.js");
  let status = 5;
  let mutated = false;
  let actor = "";
  globalThis.fetch = async (_url, init) => {
    if (init?.method === "POST") {
      mutated = true;
      actor = (init.headers as Record<string, string>)["X-Api-User"]!;
      return new Response("{}");
    }
    return new Response(
      JSON.stringify({ requestedBy: { id: 9 }, status, type: "movie", is4k: false }),
    );
  };
  await assert.rejects(() =>
    handleRequestChange(ctx(42, { id: 19, action: "retry", confirmed: true })),
  );
  assert.equal(mutated, false);
  status = 4;
  await handleRequestChange(ctx(42, { id: 19, action: "retry", confirmed: true }));
  assert.equal(actor, "9");
});

test("library refresh maps exactly one title and never accepts a user-supplied path or scan scope", async () => {
  const { handleSupportAction } = await import("../src/routes/support.js");
  const { accountStore } = await import("../src/stores.js");
  accountStore.set({
    telegramUserId: 123,
    seerrUserId: 123,
    seerrUsername: "refresh-test",
    linkedAt: 1,
    manageDownloads: true,
  });
  const commands: any[] = [];
  globalThis.fetch = async (url, init) => {
    if (init?.method === "POST") {
      commands.push(JSON.parse(String(init.body)));
      return new Response("{}");
    }
    assert.ok(String(url).endsWith("/movie"));
    return new Response(
      JSON.stringify([{ id: 700, tmdbId: 321, hasFile: false, monitored: false }]),
    );
  };
  await assert.rejects(
    () =>
      handleSupportAction(
        ctx(99, { instance: "radarr", action: "refresh-library", tmdbId: 321, confirmed: true }),
      ),
    /Manage downloads/,
  );
  await handleSupportAction(
    ctx(123, {
      instance: "radarr",
      action: "refresh-library",
      tmdbId: 321,
      path: "/arbitrary",
      movieId: 999,
      confirmed: true,
    }),
  );
  assert.deepEqual(commands, [{ name: "RescanMovie", movieId: 700 }]);
  await assert.rejects(
    () =>
      handleSupportAction(
        ctx(123, { instance: "radarr", action: "refresh-library", tmdbId: 999, confirmed: true }),
      ),
    /mapping/,
  );
});
