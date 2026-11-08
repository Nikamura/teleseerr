import { mkdir, writeFile } from 'node:fs/promises';
const endpoints=[['Teleseerr',process.env.TELESEERR_PUBLIC_URL],['Requests',process.env.SEERR_PUBLIC_URL],['Playback server',process.env.PLEX_PUBLIC_URL]].filter(([,url])=>url);
const services=await Promise.all(endpoints.map(async([name,url])=>{
 const started=Date.now();try{const response=await fetch(url,{signal:AbortSignal.timeout(15000),redirect:'error'});const available=response.ok;await response.body?.cancel();return{name,available,latency:Date.now()-started};}catch{return{name,available:false,latency:null};}
}));
await mkdir('status',{recursive:true});await writeFile('status/status.json',JSON.stringify({checkedAt:new Date().toISOString(),services}));
