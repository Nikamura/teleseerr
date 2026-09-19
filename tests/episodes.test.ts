import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { RouteContext } from "../src/http.js";
const dir = mkdtempSync(join(tmpdir(), "teleseerr-episodes-"));
Object.assign(process.env, { TELEGRAM_BOT_TOKEN:"dummy", SEERR_URL:"https://seerr.invalid", SEERR_API_KEY:"dummy", TELESEERR_ADMIN_USER_ID:"1", TELESEERR_DATA_DIR:dir, TELESEERR_SONARR_URL:"https://sonarr.invalid", TELESEERR_SONARR_API_KEY:"dummy", LOG_LEVEL:"silent" });
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; rmSync(dir,{recursive:true,force:true}); });
const series = { id:523,tmdbId:292108,tvdbId:466276,monitored:true };
const missing = {id:40548,seriesId:523,seasonNumber:1,episodeNumber:6,title:"Episode 6",airDateUtc:"2026-08-21T20:30:00Z",hasFile:false,monitored:true};
const release = {guid:"safe",indexerId:1,title:"Ann.Droid.S01E06.1080p.WEB",size:100,protocol:"torrent",downloadAllowed:true,rejections:[],seasonNumber:1,episodeNumbers:[6]};
let episode = {...missing};
let entries: any[] = [];
let releases: any[] = [release];
let calls: {url:string;method:string;body?:unknown}[] = [];
let nextUser=100;
beforeEach(() => {
  episode={...missing};entries=[];releases=[release];calls=[];
  rmSync(join(dir,"download-switches.json"),{force:true});
  globalThis.fetch=async(url,options)=>{
    const u=new URL(String(url));const method=options?.method??"GET";
    calls.push({url:u.pathname+u.search,method,body:options?.body?JSON.parse(String(options.body)):undefined});
    let value:unknown;
    if(u.hostname==="seerr.invalid") value={id:292108,externalIds:{tvdbId:466276}};
    else if(u.pathname==="/api/v3/series") value=[series];
    else if(u.pathname==="/api/v3/episode/40548") value=episode;
    else if(u.pathname==="/api/v3/episode") value=[...Array.from({length:5},(_,i)=>({...missing,id:40543+i,episodeNumber:i+1,title:`Episode ${i+1}`,hasFile:true})),episode];
    else if(u.pathname==="/api/v3/queue") value={records:entries,totalRecords:entries.length};
    else if(u.pathname==="/api/v3/release") value=method==="GET"?releases:{};
    else throw new Error(`Unexpected path ${u.pathname}`);
    return new Response(JSON.stringify(value));
  };
});
function context(user:number,body:unknown={},params:Record<string,string>={}):{ctx:RouteContext;result:()=>any} {
 let output:any;
 return {ctx:{auth:{valid:true,userId:user},params,req:Readable.from([Buffer.from(JSON.stringify(body))]),res:{writeHead(){},end(s:string){output=JSON.parse(s);}}} as unknown as RouteContext,result:()=>output};
}
async function search(){
 const {accountStore}=await import('../src/stores.js');const {handleReleaseSearch}=await import('../src/routes/downloads.js');
 const user=nextUser++;accountStore.set({telegramUserId:user,seerrUserId:user,seerrUsername:'tester',linkedAt:1,manageDownloads:true});
 const c=context(user,{instance:'sonarr',tmdbId:292108,episodeId:40548});await handleReleaseSearch(c.ctx);return {user,...c.result()};
}
test('Ann Droid exposes all six episodes with the missing episode searchable without a queue',async()=>{
 const {handleDownloads}=await import('../src/routes/downloads.js');
 const c=context(1,{}, {type:'tv',id:'292108'});await handleDownloads(c.ctx);
 assert.equal(c.result().items.length,0);
 const episodes=c.result().libraries[0].episodes;
 assert.equal(episodes.filter((e:any)=>e.state==='available').length,5);
 assert.equal(episodes[5].state,'missing');assert.equal(episodes[5].canSearch,true);
 assert.equal(episodes[5].queueId,undefined);
});
test('episode visibility is available without download-management permission, actions are not',async()=>{
 const {handleDownloads,handleReleaseSearch}=await import('../src/routes/downloads.js');
 const c=context(888,{}, {type:'tv',id:'292108'});await handleDownloads(c.ctx);
 assert.equal(c.result().libraries[0].episodes.length,6);
 assert.equal(c.result().libraries[0].episodes[5].canSearch,false);
 await assert.rejects(handleReleaseSearch(context(888,{instance:'sonarr',tmdbId:292108,episodeId:40548}).ctx),/permission/);
});
test('missing-episode selection grabs exactly the episode without deleting any queue item',async()=>{
 const {handleReleaseSwitch}=await import('../src/routes/downloads.js');
 const data=await search();assert.equal(data.action,'download');assert.deepEqual(data.releases[0].problems,[]);
 const c=context(data.user,{token:data.token,index:0,confirmed:true});await handleReleaseSwitch(c.ctx);
 assert.equal(c.result().success,true);
 assert.deepEqual(calls.find(c=>c.method==='POST')?.body,{guid:'safe',indexerId:1,seriesId:523,episodeIds:[40548]});
 assert.equal(calls.some(c=>c.method==='DELETE'),false);
 await assert.rejects(handleReleaseSwitch(context(data.user,{token:data.token,index:0,confirmed:true}).ctx),/expired/);
});
test('downloaded or newly queued episodes cannot be grabbed from stale search results',async()=>{
 const {handleReleaseSwitch}=await import('../src/routes/downloads.js');
 let data=await search();episode.hasFile=true;
 await assert.rejects(handleReleaseSwitch(context(data.user,{token:data.token,index:0,confirmed:true}).ctx),/no longer missing/);
 episode.hasFile=false;data=await search();entries=[{id:4,seriesId:523,episodeId:40548,downloadId:'new',size:10,sizeleft:8,status:'downloading'}];
 await assert.rejects(handleReleaseSwitch(context(data.user,{token:data.token,index:0,confirmed:true}).ctx),/no longer missing/);
 assert.equal(calls.some(c=>c.method==='POST'),false);
});
test('unmonitored, unaired, and mismatched-series episode targets are rejected',async()=>{
 episode.monitored=false;await assert.rejects(search(),/no longer missing/);
 episode.monitored=true;episode.airDateUtc='2099-01-01T00:00:00Z';await assert.rejects(search(),/no longer missing/);
 episode.airDateUtc=missing.airDateUtc;episode.seriesId=999;await assert.rejects(search(),/does not belong/);
 assert.equal(calls.some(c=>c.method==='POST'),false);
});
test('missing episode keeps all release rejections and disallows season packs or wrong episodes',async()=>{
 releases=[{...release,rejected:true,rejections:['Release in queue already meets cutoff: WEB']},{...release,fullSeason:true},{...release,episodeNumbers:[5]}];
 const data=await search();assert.ok(data.releases.every((r:any)=>r.problems.length>0));
 const {handleReleaseSwitch}=await import('../src/routes/downloads.js');
 await assert.rejects(handleReleaseSwitch(context(data.user,{token:data.token,index:0,confirmed:true}).ctx),/eligible/);
 assert.equal(calls.some(c=>c.method==='POST'),false);
});
test('episode states distinguish import, missing, unknown date and unaired',async()=>{
 const {episodeState}=await import('../src/routes/downloads.js');
 assert.equal(episodeState({...missing,hasFile:true},[]),'available');
 assert.equal(episodeState(missing,[],Date.parse('2026-09-19')),'missing');
 assert.equal(episodeState({...missing,airDateUtc:'2099-01-01'},[]),'unaired');
 assert.equal(episodeState({...missing,airDateUtc:undefined},[]),'unknown');
 assert.equal(episodeState(missing,[{id:2,downloadId:'x',title:'x',size:1,sizeleft:0,status:'completed'}]),'importing');
});
