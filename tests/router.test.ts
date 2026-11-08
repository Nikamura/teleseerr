import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
function setup(path = "/", state: any = null) {
 const entries = [{path,state}]; let index = 0; let listener: ()=>void; const rendered: any[]=[];
 const location = {pathname:path}; const window = {scrollY:0,scrollTo(_x:number,y:number){window.scrollY=y;}};
 const history = {
  get state(){return entries[index]!.state;},scrollRestoration:"auto",
  replaceState(next:any,_unused:string,url?:string){entries[index]={path:url??location.pathname,state:next};if(url)location.pathname=url;},
  pushState(next:any,_unused:string,url:string){entries.splice(index+1);entries.push({path:url,state:next});index++;location.pathname=url;},
  back(){if(index>0){index--;location.pathname=entries[index]!.path;listener();}},
  forward(){if(index<entries.length-1){index++;location.pathname=entries[index]!.path;listener();}}
 };
 const code=readFileSync("web/router.js","utf8").replace(/export /g,"")+"\n({parseRoute,navigate,backRoute,startRouter,tabPath})";
 const router=runInNewContext(code,{location,history,window,console,Promise,addEventListener:(_n:string,f:()=>void)=>{listener=f;}});
 router.startRouter((route:any,s:any)=>{rendered.push({route,state:s});});
 return {router,history,location,entries,rendered,window};
}
test("routes resolve navigation screens, title/person deep links and reject unsafe paths",()=>{
 const {router,location}=setup("/tv/1421");assert.equal(location.pathname,"/tv/1421");assert.equal(router.parseRoute("/person/123").kind,"person");
 for(const path of ["/tv/0","/movie/-1","/tv/9007199254740992","/secret-token","https://other.test/"])assert.equal(router.parseRoute(path).path,"/discover");
 for(const tab of ["trending","movies","tv","anime","requests","admin","profile"])assert.equal(router.parseRoute(router.tabPath(tab)).tab,tab);
});
test("browser Back and Forward follow tab, title and cast navigation",()=>{
 const {router,location,history,entries}=setup();router.navigate("/requests");router.navigate("/tv/1421");router.navigate("/person/123");router.backRoute();assert.equal(location.pathname,"/tv/1421");history.back();assert.equal(location.pathname,"/requests");history.forward();assert.equal(location.pathname,"/tv/1421");
 const count=entries.length;router.navigate("/tv/1421");assert.equal(entries.length,count);
});
test("direct deep-link Back stays in the app and launch data is not copied to history",()=>{
 const {router,history,location}=setup("/movie/123",{token:"private",tgWebAppData:"secret"});router.backRoute();assert.equal(location.pathname,"/discover");assert.ok(!JSON.stringify(history.state).includes("private"));assert.ok(!JSON.stringify(history.state).includes("secret"));
});
test("search terms stay in local history state and typing replaces rather than grows history",()=>{
 const {router,entries,history,location}=setup();router.navigate("/search",{query:"private title"});const count=entries.length;router.navigate("/search",{replace:true,query:"private title more"});assert.equal(entries.length,count);assert.equal(location.pathname,"/search");assert.equal(history.state.teleseerr.query,"private title more");assert.ok(entries.every(e=>!e.path.includes("private")));
});
test("route history restores the previous scroll position",async()=>{
 const {router,window}=setup();await new Promise(r=>setImmediate(r));window.scrollY=650;router.navigate("/requests");await new Promise(r=>setImmediate(r));assert.equal(window.scrollY,0);router.backRoute();await new Promise(r=>setImmediate(r));assert.equal(window.scrollY,650);
});
