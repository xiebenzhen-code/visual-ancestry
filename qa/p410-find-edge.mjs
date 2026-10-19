// Real Edge/product route; historical find.js response substitution is labelled explicitly.
// Provider disabled. Public network blocked. No model invocation.
// node qa/p410-find-edge.mjs [repository root] [local evidence directory]
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,mkdtempSync,existsSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {setTimeout as sleep} from 'node:timers/promises';
const ROOT=path.resolve(process.argv[2]||'.');
const OUT=path.resolve(process.argv[3]||'.rc1-audit/p410-recheck');mkdirSync(OUT,{recursive:true});
const EDGE=process.env.EDGE_PATH||'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT=Number(process.env.P410_TEST_PORT||4519),CDP=Number(process.env.P410_CDP_PORT||9519),BASE=`http://127.0.0.1:${PORT}`;
// Fail on occupied ports rather than connecting to a different server/profile.
const {createServer}=await import('node:net');
for(const port of [PORT,CDP])await new Promise((resolve,reject)=>{const s=createServer();s.once('error',reject);s.listen(port,'127.0.0.1',()=>s.close(resolve));});
const env={...process.env};for(const k of Object.keys(env))if(/VISION|OPENAI|ANTHROPIC|DEEPSEEK/i.test(k))delete env[k];Object.assign(env,{HOST:'127.0.0.1',PORT:String(PORT)});
const srv=spawn(process.execPath,['scripts/server.mjs','.',String(PORT)],{cwd:ROOT,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
let serverLog='';srv.stdout.on('data',d=>serverLog+=d);srv.stderr.on('data',d=>serverLog+=d);
let edge,ws;const rows=[],errors=[],visionRequests=[];let mode='current';let pass=0;
const profile=mkdtempSync(path.join(os.tmpdir(),'va-p410-recheck-'));
async function waitFor(fn,label){for(let i=0;i<70;i++){try{const v=await fn();if(v)return v;}catch{}await sleep(150);}throw Error(`Timeout: ${label}`);}
function check(name,condition,detail){assert.ok(condition,`${name}: ${JSON.stringify(detail)}`);pass++;rows.push({name,pass:true,detail});console.log(`PASS ${name}`);}
try{
 await waitFor(async()=>(await fetch(BASE+'/healthz')).ok,'server');
 const status=await (await fetch(BASE+'/api/vision/status')).json();check('server provider disabled',status.provider==='not-configured',status.provider);
 edge=spawn(EDGE,['--headless=new',`--remote-debugging-port=${CDP}`,`--user-data-dir=${profile}`,'--no-first-run','--no-default-browser-check','--disable-extensions','--disable-background-networking','about:blank'],{windowsHide:true,stdio:'ignore'});
 const target=await waitFor(async()=>((await(await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()).find(x=>x.type==='page')),'Edge');
 ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej;});
 let id=0;const pending=new Map();
 const call=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;const timer=setTimeout(()=>{pending.delete(n);reject(Error(`CDP timeout ${method}`));},12000);pending.set(n,m=>{clearTimeout(timer);m.error?reject(Error(JSON.stringify(m.error))):resolve(m.result);});ws.send(JSON.stringify({id:n,method,params}));});
 const old=execFileSync('git',['show','119e229e48a1c962c3abee63e306f728b8240857^:src/pages/find.js'],{cwd:ROOT,encoding:'utf8'});
 ws.onmessage=event=>{const m=JSON.parse(event.data);if(m.id){pending.get(m.id)?.(m);pending.delete(m.id);return;}
  if(m.method==='Runtime.exceptionThrown')errors.push({mode,text:m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text});
  if(m.method==='Fetch.requestPaused'){
   const p=m.params,u=new URL(p.request.url);let action;
   if(u.pathname==='/api/vision'&&p.request.method==='POST'){visionRequests.push({mode,path:u.pathname});action=call('Fetch.failRequest',{requestId:p.requestId,errorReason:'BlockedByClient'});}
   else if(u.origin!==BASE&&!['data:','blob:'].includes(u.protocol))action=call('Fetch.failRequest',{requestId:p.requestId,errorReason:'BlockedByClient'});
   else if(mode==='historical'&&u.pathname==='/src/pages/find.js')action=call('Fetch.fulfillRequest',{requestId:p.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'text/javascript'}],body:Buffer.from(old).toString('base64')});
   else action=call('Fetch.continueRequest',{requestId:p.requestId});
   action.catch(e=>errors.push({mode,text:'interception: '+e.message}));
  }
 };
 await call('Page.enable');await call('Runtime.enable');await call('Network.enable');await call('Network.setCacheDisabled',{cacheDisabled:true});await call('Fetch.enable',{patterns:[{urlPattern:'*'}]});
 const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result?.value;};
 const navigate=async(hash)=>{await call('Page.navigate',{url:'about:blank'});await call('Page.navigate',{url:BASE+'/'+hash});await waitFor(()=>evaluate('!!document.querySelector("#find-text")'),'find controls');await sleep(300);};
 const directRender=()=>evaluate(`(async()=>{try{const m=await import('/src/pages/find.js');m.renderFind(document.querySelector('#app'));return {ok:true,uploadMissing:!document.querySelector('#find-file'),search:!!document.querySelector('#find-run'),remote:!!document.querySelector('#find-remote')};}catch(e){return {ok:false,name:e.name,message:e.message};}})()`);
 mode='historical';await navigate('#find');const before=await directRender();check('historical module reproduces null addEventListener TypeError',!before.ok&&before.name==='TypeError'&&/addEventListener/.test(before.message),before);
 mode='current';await navigate('#find');const after=await directRender();check('current actual renderFind completes without upload controls',after.ok&&after.uploadMissing&&after.search&&after.remote,after);
 await evaluate(`document.querySelector('#find-text').value='夜晚 冷色';document.querySelector('#find-run').click();`);
 await waitFor(()=>evaluate('document.querySelectorAll("#find-results .find-hit").length>0'),'local results');
 check('find search listener produces real local results',await evaluate('document.querySelectorAll("#find-results .find-hit").length>0'));
 await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
 await navigate('#find');check('mobile find route completes',(await directRender()).ok);
 const shot=await call('Page.captureScreenshot',{format:'png'});writeFileSync(path.join(OUT,'find-mobile.png'),Buffer.from(shot.data,'base64'));
 await call('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});await navigate('');
 const input=await evaluate(`(async()=>{const f=await(await fetch('/public/assets/artworks/american-gothic/thumb.webp')).blob();const dt=new DataTransfer();dt.items.add(new File([f],'local-preview.webp',{type:'image/webp'}));const el=document.querySelector('#find-file');el.files=dt.files;el.dispatchEvent(new Event('change',{bubbles:true}));const img=document.querySelector('#find-preview');await img.decode();return {visible:!img.hidden,width:img.naturalWidth,run:!document.querySelector('#find-image-run').hidden};})()`);
 check('home file-change handler previews actual local image',input.visible&&input.width>0&&input.run,input);
 check('home remove handler resets preview and file',await evaluate(`document.querySelector('#find-clear').click();document.querySelector('#find-preview').hidden&&document.querySelector('#find-file').value===''&&document.querySelector('#find-image-run').hidden`));
 // Existing P4.2 response replay is browser integration, not a new provider test.
 const replayPath=path.join(ROOT,'.p42-evidence/real-call.json');
 if(existsSync(replayPath)){
 const ev=JSON.parse(readFileSync(replayPath,'utf8'));
 await evaluate(`window.__P410_REPLAYS=0;window.__FA_TEST_VISION=async()=>{window.__P410_REPLAYS++;return {ok:true,raw:${JSON.stringify(ev.response.body.intent)},latencyMs:0};};`);
 await evaluate(`document.querySelector('[data-find-mode="image"]').click();`);
 await evaluate(`(async()=>{const b=await(await fetch('/public/assets/artworks/american-gothic/thumb.webp')).blob();const dt=new DataTransfer();dt.items.add(new File([b],'local-replay.webp',{type:'image/webp'}));const el=document.querySelector('#find-file');el.files=dt.files;el.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('#find-image-run').click();})()`);
 await waitFor(()=>evaluate('window.__P410_REPLAYS===1&&document.querySelectorAll("#find-results .find-hit").length>0'),'MOCK replay results');
 check('home analysis click executes existing-response MOCK replay',await evaluate('window.__P410_REPLAYS===1'));
 const shot2=await call('Page.captureScreenshot',{format:'png'});writeFileSync(path.join(OUT,'home-replay-desktop.png'),Buffer.from(shot2.data,'base64'));
 }else{rows.push({name:'home analysis existing-response MOCK replay',status:'SKIP',reason:'Private local evidence intentionally excluded from Git'});console.log('SKIP private P4.2 replay evidence absent');}
 check('current route has no uncaught JavaScript exceptions',errors.filter(e=>e.mode==='current').length===0,errors.filter(e=>e.mode==='current'));
 check('zero POST /api/vision attempts',visionRequests.length===0,visionRequests);
 writeFileSync(path.join(OUT,'edge-results.json'),JSON.stringify({at:new Date().toISOString(),pass,rows,errors,visionRequests,profile,mode:'REAL Edge + MOCK replay; historical find module substituted; external network blocked'},null,2));
 console.log(JSON.stringify({pass,paidVisionCalls:0,evidence:OUT}));
 await call('Browser.close').catch(()=>{});
}finally{ws?.close();edge?.kill();srv.kill();writeFileSync(path.join(OUT,'server.log'),serverLog);}
