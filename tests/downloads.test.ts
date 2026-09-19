import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { RouteContext } from "../src/http.js";
const dir = mkdtempSync(join(tmpdir(), "teleseerr-downloads-"));
Object.assign(process.env, { TELEGRAM_BOT_TOKEN: "dummy", SEERR_URL: "https://seerr.invalid", SEERR_API_KEY: "dummy", TELESEERR_ADMIN_USER_ID: "1", TELESEERR_DATA_DIR: dir, TELESEERR_RADARR_URL: "https://radarr.invalid", TELESEERR_RADARR_API_KEY: "dummy", LOG_LEVEL: "silent" });
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; rmSync(dir, { recursive: true, force: true }); });
function ctx(user: number, body: unknown = {}, params = {}): { context: RouteContext; result: () => any } {
  let result: any;
  return { context: { auth: { userId: user, valid: true }, req: Readable.from([Buffer.from(JSON.stringify(body))]), params, res: { writeHead() {}, end(value: string) { result = JSON.parse(value); } } } as unknown as RouteContext, result: () => result };
}
const item = { id: 5, downloadId: "old-hash", movieId: 8, title: "Old", size: 100, sizeleft: 60, status: "downloading", movie: { tmdbId: 11 } };
const candidate = { guid: "new-guid", indexerId: 3, title: "New", size: 90, protocol: "torrent", rejected: true, downloadAllowed: true, rejections: ["Release in queue is of equal or higher preference: WEB 1080p"], infoHash: "new-hash" };
let rows = [item];
let calls: string[] = [];
let failGrab = false, failDelete = false;
function mock() {
  calls = []; rows = [{...item}]; failGrab = false; failDelete = false;
  globalThis.fetch = async (url, options) => {
    const path = new URL(String(url)).pathname; const method = options?.method ?? "GET";
    calls.push(`${method} ${path}`);
    if (method === "POST" && failGrab) throw new Error("timeout");
    if (method === "DELETE" && failDelete) throw new Error("timeout");
    if (method === "POST") rows.push({...item, id:6, downloadId:"new-hash", title:"New"});
    const value = path.endsWith("/queue") ? { records: rows, totalRecords: rows.length } : path.endsWith("/release") && method === "GET" ? [candidate] : {};
    return new Response(JSON.stringify(value));
  };
}
async function grant(id: number) {
  const { accountStore } = await import("../src/stores.js");
  accountStore.set({ telegramUserId: id, seerrUserId: id, seerrUsername: `user${id}`, linkedAt: 1, manageDownloads: true });
}
async function search(user: number) {
  const { handleReleaseSearch } = await import("../src/routes/downloads.js");
  const c = ctx(user, { instance: "radarr", queueId: 5 }); await handleReleaseSearch(c.context); return c.result();
}
test("permission defaults off, admin on, changes persist and unlinked users lose permission", async () => {
  const { canManageDownloads, handleReleaseSearch } = await import("../src/routes/downloads.js");
  const { accountStore } = await import("../src/stores.js");
  const { handleAdminDownloadPermission } = await import("../src/routes/admin.js");
  assert.equal(canManageDownloads(1), true); assert.equal(canManageDownloads(22), false);
  await assert.rejects(handleReleaseSearch(ctx(22).context), /permission/);
  await grant(22);
  await handleAdminDownloadPermission(ctx(1, {telegramUserId:22, enabled:false}).context);
  assert.equal(canManageDownloads(22), false);
  assert.equal(JSON.parse(readFileSync(join(dir, "links.json"), "utf8"))["22"].manageDownloads, false);
  await handleAdminDownloadPermission(ctx(22, {telegramUserId:22, enabled:true}).context);
  assert.equal(canManageDownloads(22), false);
  await grant(22); accountStore.delete(22); assert.equal(canManageDownloads(22), false);
});
test("only queue conflicts are exempt; quality rejections, same torrent, and mismatched episodes stay blocked", async () => {
  const { releaseProblems } = await import("../src/routes/downloads.js");
  assert.deepEqual(releaseProblems(candidate, [item]), []);
  assert.ok(releaseProblems({...candidate, downloadAllowed:false}, [item]).length);
  assert.ok(releaseProblems({...candidate, rejections:[...candidate.rejections,"Quality is not wanted"]}, [item]).length);
  assert.ok(releaseProblems({...candidate, infoHash:"OLD-HASH"}, [item]).length);
  const episode = {...item, movieId:undefined, seriesId:4, episodeId:9, episode:{seasonNumber:3, episodeNumber:4}};
  assert.deepEqual(releaseProblems({...candidate, seasonNumber:3, episodeNumbers:[4]}, [episode]), []);
  assert.ok(releaseProblems({...candidate, seasonNumber:3, episodeNumbers:[5]}, [episode]).length);
  assert.ok(releaseProblems({...candidate, seasonNumber:3, fullSeason:true}, [episode]).length);
  assert.ok(releaseProblems({...candidate, seasonNumber:3, episodeNumbers:[4]}, [episode,{...episode,id:6,episodeId:10,episode:{seasonNumber:3,episodeNumber:5}}]).length);
});
test("non-requester can replace; grab precedes removal; token replay and cross-user use blocked", async () => {
  const { handleReleaseSwitch } = await import("../src/routes/downloads.js");
  mock(); await grant(31); await grant(32);
  const data = await search(31);
  assert.equal(JSON.stringify(data).includes("new-guid"), false);
  await assert.rejects(handleReleaseSwitch(ctx(32,{token:data.token,index:0,confirmed:true}).context), /expired/);
  const c=ctx(31,{token:data.token,index:0,confirmed:true}); await handleReleaseSwitch(c.context);
  assert.equal(c.result().success,true);
  assert.ok(calls.indexOf("POST /api/v3/release") < calls.indexOf("DELETE /api/v3/queue/5"));
  await assert.rejects(handleReleaseSwitch(c.context), /JSON|expired/);
  await assert.rejects(handleReleaseSwitch(ctx(31,{token:data.token,index:0,confirmed:true}).context), /expired/);
});
test("permission revoked after search prevents mutation", async () => {
  const { handleReleaseSwitch } = await import("../src/routes/downloads.js");
  const { accountStore } = await import("../src/stores.js");
  mock(); await grant(41); const data = await search(41); accountStore.delete(41);
  await assert.rejects(handleReleaseSwitch(ctx(41,{token:data.token,index:0,confirmed:true}).context), /permission/);
  assert.equal(calls.some(c=>c.startsWith("POST")), false);
});
test("changed transfer identity prevents mutation", async () => {
  const { handleReleaseSwitch } = await import("../src/routes/downloads.js");
  mock(); await grant(42); const data = await search(42); rows=[{...item, downloadId:"different"}];
  await assert.rejects(handleReleaseSwitch(ctx(42,{token:data.token,index:0,confirmed:true}).context), /changed/);
  assert.equal(calls.some(c=>c.startsWith("POST")), false);
});
test("ambiguous grab never removes old transfer or allows token replay", async () => {
  const { handleReleaseSwitch } = await import("../src/routes/downloads.js");
  rmSync(join(dir,"download-switches.json"),{force:true}); mock(); await grant(43); const data = await search(43); failGrab=true;
  await assert.rejects(handleReleaseSwitch(ctx(43,{token:data.token,index:0,confirmed:true}).context), /not removed/);
  assert.equal(calls.some(c=>c.startsWith("DELETE")),false);
  await assert.rejects(handleReleaseSwitch(ctx(43,{token:data.token,index:0,confirmed:true}).context), /expired/);
});
test("cleanup failure reports partial success and persistent cooldown blocks a second switch", async () => {
  const { handleReleaseSwitch } = await import("../src/routes/downloads.js");
  rmSync(join(dir,"download-switches.json"),{force:true}); mock(); await grant(44); const data = await search(44); failDelete=true;
  const c=ctx(44,{token:data.token,index:0,confirmed:true}); await handleReleaseSwitch(c.context);
  assert.equal(c.result().success,true); assert.match(c.result().warning,/old transfer/);
  await grant(45); const next=await search(45);
  await assert.rejects(handleReleaseSwitch(ctx(45,{token:next.token,index:0,confirmed:true}).context), /recently attempted/);
});
