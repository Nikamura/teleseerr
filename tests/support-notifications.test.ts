import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { Bot } from "grammy";
const dir = mkdtempSync(join(tmpdir(), "teleseerr-report-alerts-"));
Object.assign(process.env, { TELEGRAM_BOT_TOKEN: "dummy", SEERR_URL: "https://seerr.invalid", SEERR_API_KEY: "dummy", TELESEERR_ADMIN_USER_ID: "1", TELESEERR_DATA_DIR: dir, TELESEERR_MINI_APP_URL: "https://teleseerr.invalid", LOG_LEVEL: "silent" });
after(() => rmSync(dir, { recursive: true, force: true }));
const input = { owner: 42, type: "tv" as const, tmdbId: 1421, title: "Modern <Family> _test_", season: 6, episode: 16, episodeId: 616, category: "playback", device: "Samsung TV", notes: "Freezes after 5 seconds. <b>Not HTML</b>", fileIds: [] };

test("reports notify only the admin, include context and links, deduplicate and track user updates", async () => {
 const store = await import("../src/support-store.js");
 const { accountStore } = await import("../src/stores.js");
 const { flushReportNotifications } = await import("../src/support-notifications.js");
 accountStore.set({ telegramUserId: 42, seerrUserId: 9, seerrUsername: "viewer", linkedAt: Date.now() });
 const r = store.createReport(input); store.createReport(input);
 const sent: any[] = []; let unblock!: () => void;
 const bot = { api: { sendMessage: async (...args: any[]) => { sent.push(args); await new Promise<void>(resolve => { unblock = resolve; }); } } } as unknown as Bot;
 const first = flushReportNotifications(bot); await new Promise(resolve => setImmediate(resolve));
 await flushReportNotifications(bot); assert.equal(sent.length, 1); unblock(); await first;
 assert.equal(sent[0][0], 1); assert.match(sent[0][1], /New problem report/); assert.match(sent[0][1], /S06E16/); assert.match(sent[0][1], /viewer/); assert.match(sent[0][1], /Samsung TV/); assert.match(sent[0][1], /<b>Not HTML<\/b>/); assert.equal(sent[0][2].parse_mode, undefined);
 assert.equal(sent[0][2].reply_markup.inline_keyboard[0][0].web_app.url, "https://teleseerr.invalid/tv/1421");
 assert.equal(store.pendingReportNotifications().length, 0);
 store.createReport(input); assert.equal(store.pendingReportNotifications().length, 0);
 store.updateReport(r.id, 42, false, "resolved", "");
 store.updateReport(r.id, 42, false, "resolved", "");
 store.updateReport(r.id, 42, false, "open", "Still broken");
 store.updateReport(r.id, 1, true, "investigating", "Admin investigating");
 assert.deepEqual(store.pendingReportNotifications().map(n => n.event), ["resolved", "reopened"]);
 const immediate = { api: { sendMessage: async (...args: any[]) => { sent.push(args); } } } as unknown as Bot;
 await flushReportNotifications(immediate); assert.equal(sent.length, 3); assert.match(sent[1][1], /marked the problem fixed/); assert.match(sent[2][1], /reopened/); assert.match(sent[2][1], /Still broken/);
});

test("Telegram failure preserves the saved report and persistent notification for retry after restart", async () => {
 const store = await import("../src/support-store.js"); const { flushReportNotifications } = await import("../src/support-notifications.js");
 const r = store.createReport({ ...input, tmdbId: 99 });
 await flushReportNotifications({ api: { sendMessage: async () => { throw Error("Telegram unavailable"); } } } as unknown as Bot);
 assert.ok(store.reports(42).find(x => x.id === r.id)); assert.equal(store.pendingReportNotifications().length, 0);
 const future = Date.now() + 3600001;
 assert.equal(store.pendingReportNotifications(future)[0]!.attempts, 1);
 const output = execFileSync(process.execPath, ["--import", "tsx", "-e", "(async()=>{const s=await import('./src/support-store.ts');console.log(s.pendingReportNotifications(Date.now()+3600001).length)})()"], { env: process.env }).toString();
 assert.match(output, /^1\s*$/);
 let sends = 0; await flushReportNotifications({ api: { sendMessage: async () => { sends++; } } } as unknown as Bot, future);
 assert.equal(sends, 1); assert.equal(store.pendingReportNotifications(future).length, 0);
});

test("migration forwards unresolved reports once, and messages stay under Telegram limits", async () => {
 const store = await import("../src/support-store.js"); const { reportMessage } = await import("../src/support-notifications.js");
 const path = join(dir, "support.json"), data = JSON.parse(readFileSync(path, "utf8"));
 delete data.reportNotifications; data.reports[0].status = "resolved"; writeFileSync(path, JSON.stringify(data));
 const pending = store.pendingReportNotifications(); assert.equal(pending.length, 1); assert.equal(pending[0]!.event, "existing");
 store.completeReportNotification(pending[0]!.id); assert.equal(store.pendingReportNotifications().length, 0);
 const message = reportMessage({ ...pending[0]!, message: "x".repeat(5000), report: { ...pending[0]!.report, title: "x".repeat(5000), notes: "x".repeat(5000) } });
 assert.ok(message.length <= 4000); assert.ok(message.includes(pending[0]!.report.id));
});

test("admin resolution notifies only the report owner with the admin's note, without duplicate or identity leaks", async () => {
 const s = await import("../src/support-store.js"), n = await import("../src/support-notifications.js");
 const sent: any[] = [], bot = { api: { sendMessage: async (...args: any[]) => { sent.push(args); } } } as unknown as Bot;
 const r=s.createReport({...input,tmdbId:700}); await n.flushReportNotifications(bot); sent.length=0;
 s.updateReport(r.id,1,true,"resolved","Replaced the broken file. Please try again.");
 s.updateReport(r.id,1,true,"resolved","");
 assert.equal(s.pendingReportNotifications().length,1); assert.equal(s.pendingReportNotifications()[0]!.audience,"reporter");
 await n.flushReportNotifications(bot); assert.equal(sent.length,1); assert.equal(sent[0][0],42);
 assert.match(sent[0][1],/marked resolved/); assert.match(sent[0][1],/Replaced the broken file/); assert.match(sent[0][1],/S06E16/);
 assert.ok(!sent[0][1].includes("viewer")); assert.ok(!sent[0][1].includes("Telegram 42"));
 assert.equal(sent[0][2].reply_markup.inline_keyboard[0][0].web_app.url,"https://teleseerr.invalid/tv/700");
});

test("a replacement alerts the owner once and remains unconfirmed; a still-broken file does not alert again", async () => {
 const s=await import("../src/support-store.js"), n=await import("../src/support-notifications.js");
 const sent:any[]=[];const bot={api:{sendMessage:async(...args:any[])=>{sent.push(args);}}} as unknown as Bot;
 const r=s.createReport({...input,tmdbId:701,fileIds:["sonarr:1"]});await n.flushReportNotifications(bot);sent.length=0;
 s.markReplacement(42,"tv",701,616,["sonarr:1"]);assert.equal(s.pendingReportNotifications().length,0);
 s.markReplacement(42,"tv",701,616,["sonarr:2"]);s.markReplacement(42,"tv",701,616,["sonarr:2"]);
 assert.equal(s.pendingReportNotifications().length,1);await n.flushReportNotifications(bot);
 assert.equal(sent.length,1);assert.equal(sent[0][0],42);assert.match(sent[0][1],/replacement file is ready/);assert.ok(!sent[0][1].includes("marked resolved"));
 assert.equal(s.reports(42).find(x=>x.id===r.id)!.status,"replacement_available");
 s.updateReport(r.id,42,false,"open","");s.markReplacement(42,"tv",701,616,["sonarr:2"]);
 assert.ok(s.pendingReportNotifications().every(x=>x.audience!=="reporter"));await n.flushReportNotifications(bot);
 sent.length=0;s.updateReport(r.id,42,false,"resolved","");await n.flushReportNotifications(bot);
 assert.deepEqual(sent.map(x=>x[0]),[1]); // User confirmation alerts admin, not an echo to the user.
});

test("a newer resolution supersedes a pending replacement, retries persist the owner, and stale or revoked notices are dropped", async () => {
 const s=await import("../src/support-store.js"), n=await import("../src/support-notifications.js");
 const sent:any[]=[];const bot={api:{sendMessage:async(...args:any[])=>{sent.push(args);}}} as unknown as Bot;
 const r=s.createReport({...input,tmdbId:702});await n.flushReportNotifications(bot);
 s.markReplacement(42,"tv",702,616,["sonarr:99"]);s.updateReport(r.id,1,true,"resolved","Fixed");
 assert.equal(s.pendingReportNotifications().length,1);assert.equal(s.pendingReportNotifications()[0]!.event,"resolved");
 await n.flushReportNotifications({api:{sendMessage:async()=>{throw Error("offline")}}} as unknown as Bot);
 const persisted=JSON.parse(readFileSync(join(dir,"support.json"),"utf8")).reportNotifications;
 assert.equal(persisted[0].audience,"reporter");assert.equal(persisted[0].report.owner,42);
 sent.length=0;await n.flushReportNotifications(bot,Date.now()+3600001);assert.deepEqual(sent.map(x=>x[0]),[42]);
 s.updateReport(r.id,42,false,"open","");await n.flushReportNotifications(bot);
 s.markReplacement(42,"tv",702,616,["sonarr:100"]);s.updateReport(r.id,42,false,"open","");sent.length=0;
 await n.flushReportNotifications(bot);assert.ok(sent.every(x=>x[0]!==42));
 const revoked=s.createReport({...input,owner:43,tmdbId:703});await n.flushReportNotifications(bot);s.updateReport(revoked.id,1,true,"resolved","");sent.length=0;
 await n.flushReportNotifications(bot);assert.equal(sent.length,0);assert.equal(s.pendingReportNotifications().length,0);
});

test("legacy queued notices without an audience still go to the admin", async () => {
 const s=await import("../src/support-store.js"), n=await import("../src/support-notifications.js");
 s.createReport({...input,tmdbId:704});const path=join(dir,"support.json"),data=JSON.parse(readFileSync(path,"utf8"));
 for(const notice of data.reportNotifications)delete notice.audience;
 writeFileSync(path,JSON.stringify(data));const recipients:number[]=[];
 await n.flushReportNotifications({api:{sendMessage:async(id:number)=>{recipients.push(id);}}} as unknown as Bot);
 assert.deepEqual(recipients,[1]);
});
