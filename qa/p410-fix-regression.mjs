// Product-path regression. MOCK provider, real scoring/fetch(File) pipeline. No paid calls.
// node qa/p410-fix-regression.mjs [repository root]
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const ROOT=path.resolve(process.argv[2]||'.');
const url=p=>pathToFileURL(path.join(ROOT,p)).href;
const git=(...a)=>execFileSync('git',a,{cwd:ROOT,encoding:'utf8'});
const fixed=(await import(url('src/services/source/filmVisionRerank.js'))).rerankWithVision;
const original=git('show','119e229e48a1c962c3abee63e306f728b8240857^:src/services/source/filmVisionRerank.js');
const historic=async s=>(await import('data:text/javascript;base64,'+Buffer.from(s.replace(/from "(\.\.[^"]+)"/g,(_,p)=>`from ${JSON.stringify(url(path.join('src/services/source',p)))}`)).toString('base64'))).rerankWithVision;
const old=await historic(original);
const typoOnly=await historic(original.replace('b.s - s.s','b.s - a.s'));
const query={subjectScale:'small',negativeSpace:'high',colorTemperature:'cool'};
const intents={low:{colorTemperature:'cool'},high:{...query},mid:{subjectScale:'small'},tie:{...query}};
let calls=0, fetches=0;
const nativeFetch=globalThis.fetch;
globalThis.fetch=async(input,...rest)=>{assert.ok(String(input).startsWith('data:image/'),'External network is forbidden');fetches++;return nativeFetch(input,...rest);};
const refs=()=>['low','high','mid','tie','missing'].map(sourceId=>({sourceId,showable:true,image:{url:`data:image/png,${sourceId}`}}));
const analyze=async file=>{calls++;assert.ok(file instanceof File);const id=await file.text();return intents[id]?{ok:true,intent:intents[id]}:{ok:false,error:'fixture-missing'};};
const opts={authorized:true,maxCandidates:5,queryIntent:query,probe:async()=>true,analyze};
let passed=0;
async function test(name,fn){await fn();passed++;console.log(`PASS ${name}`);}
try{
 await test('historical full function throws ReferenceError',async()=>assert.rejects(()=>old(refs(),opts),e=>e instanceof ReferenceError&&/s is not defined/.test(e.message)));
 await test('typo-only repair leaves numeric object subtraction broken',async()=>{const r=await typoOnly(refs(),opts);assert.deepEqual(r.results.map(x=>x.sourceId),['low','high','mid','tie','missing']);assert.ok(Number.isNaN({score:1,possible:4}-{score:3,possible:4}));});
 await test('fixed full function ranks actual scoreIntent scores, stable ties, missing last',async()=>{const r=await fixed(refs(),opts);assert.deepEqual(r.results.map(x=>x.sourceId),['high','tie','mid','low','missing']);assert.equal(r.analyzed,4);assert.equal(r.attempted,5);assert.equal(r.coverage,.8);assert.equal(r.reranked,true);assert.equal(r.provenance,'stub');assert.ok(r.results.filter(x=>x.intent).every(x=>x.intentProvenance==='stub'));});
 await test('unavailable provider performs no analysis or fetch',async()=>{const before=[calls,fetches];const r=await fixed(refs(),{...opts,probe:async()=>false});assert.equal(r.reranked,false);assert.equal(r.attempted,0);assert.deepEqual([calls,fetches],before);});
 await test('unauthorized provider performs no analysis or fetch',async()=>{const before=[calls,fetches];const r=await fixed(refs(),{...opts,authorized:false});assert.equal(r.reason,'stub-not-authorized');assert.deepEqual([calls,fetches],before);});
 await test('budget cap bounds attempts and unscored entries remain last',async()=>{const r=await fixed(refs(),{...opts,maxCandidates:2});assert.equal(r.attempted,2);assert.deepEqual(r.results.map(x=>x.sourceId),['high','low','mid','tie','missing']);});
 await test('zero budget preserves order without analysis',async()=>{const before=[calls,fetches];const r=await fixed(refs(),{...opts,maxCandidates:0});assert.equal(r.reranked,false);assert.deepEqual(r.results.map(x=>x.sourceId),refs().map(x=>x.sourceId));assert.deepEqual([calls,fetches],before);});
 await test('all failed analyses do not pretend reranking succeeded',async()=>{const r=await fixed(refs(),{...opts,analyze:async()=>({ok:false,error:'fixture-failure'})});assert.equal(r.analyzed,0);assert.equal(r.reranked,false);assert.equal(r.reason,'all-attempts-failed');});
 await test('pixel distances attach evidence without changing metadata order',async()=>{const {reorderByPixels}=await import(url('src/services/retrieval/filmPixelCompare.js'));const items=['A','B','C'].map(id=>({artwork:{id}}));const r=reorderByPixels(items,[{sourceId:'A',distance:.9},{sourceId:'B',distance:.4},{sourceId:'C',distance:.1}]);assert.deepEqual(r.map(x=>x.item.artwork.id),['A','B','C']);assert.deepEqual(r.map(x=>x.pixelRank),[3,2,1]);assert.ok(r.every(x=>x.status==='pixel-compared'));});
 console.log(JSON.stringify({passed,provider:'MOCK injected stub',externalFetches:0,paidVisionCalls:0}));
}finally{globalThis.fetch=nativeFetch;}
