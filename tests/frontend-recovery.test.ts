import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";
test("failed pagination restores its action and can retry successfully",async()=>{
 const source=readFileSync('web/grid.js','utf8').replace(/^import .*$/gm,'').replace(/export /g,'');
 const notices:string[]=[];let button:any;const container={querySelector:()=>null,appendChild:(b:any)=>{button=b;}};
 const {addLoadMore}=runInNewContext(source+'\n({addLoadMore})',{document:{createElement:()=>({})},toast:(s:string)=>notices.push(s)});
 let attempts=0;addLoadMore(container,async()=>{attempts++;if(attempts===1)throw Error('temporary outage');});
 await button.onclick();assert.equal(button.disabled,false);assert.equal(button.textContent,'Load more');assert.equal(notices.length,1);
 await button.onclick();assert.equal(attempts,2);assert.equal(button.disabled,false);assert.equal(notices.length,1);
});
