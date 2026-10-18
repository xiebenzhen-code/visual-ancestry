// qa2a-followup.mjs — focused re-verification after scroll-restore + feed-persist fixes.
// 1) scroll position restored after detail -> back (real SPA hash navigation)
// 2) continuous scroll exceeds 100 items on desktop
// 3) first-screen still intact; no console errors
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 9426;
const BASE = "http://127.0.0.1:4175";
const OUT = "C:<local-path>";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PROFILE = process.cwd() + "\\work\\edge-qa2a-f";

const results = {};
const errors = [];

async function cdpConnect(wsUrl, onEvent) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws")); });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
    if (onEvent) onEvent(msg);
  };
  const send = (method, params = {}) => new Promise((resolve) => {
    const mid = ++id; pending.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  return { ws, send };
}

const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, "--no-first-run", "about:blank"], { stdio: "ignore" });
let version = null;
for (let i = 0; i < 40 && !version; i++) {
  try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch {}
  if (!version) await sleep(700);
}
if (!version) { console.log("CDP-DOWN"); process.exit(1); }
const browserWs = await cdpConnect(version.webSocketDebuggerUrl);
const created = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
const page = await cdpConnect(created.webSocketDebuggerUrl, (msg) => {
  if (msg.method === "Runtime.exceptionThrown") errors.push("EXC: " + (msg.params?.exceptionDetails?.text || "?"));
});
const call = page.send;
const evalJs = async (expr) => {
  const r = await call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
};
await call("Runtime.enable");
await call("Page.enable");
await call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 920, deviceScaleFactor: 1, mobile: false });

// --- 1) scroll restore via real hash navigation ---
await call("Page.navigate", { url: `${BASE}/#index` });
await sleep(4000);
await evalJs(`window.scrollTo(0, 860)`);
await sleep(600);
const beforeY = await evalJs(`window.scrollY`);
// click the first tile (same-document hash change -> router remembers scroll)
await evalJs(`document.querySelector('.feed-tile').click()`);
await sleep(2500);
const onDetail = await evalJs(`location.hash`);
// go back to the feed (hash navigation, not history)
await evalJs(`location.hash = '#index'`);
await sleep(2200); // re-render + restore
const afterY = await evalJs(`window.scrollY`);
const tilesAfterBack = await evalJs(`document.querySelectorAll('.feed-tile').length`);
results.scrollRestore = { beforeY, afterY, delta: Math.abs(afterY - beforeY), onDetail, tilesAfterBack };

// --- 2) continuous scroll >= 100 (cache is warm from previous QA run) ---
let tiles = await evalJs(`document.querySelectorAll('.feed-tile').length`);
for (let i = 0; i < 30 && tiles < 110; i++) {
  await evalJs(`window.scrollTo(0, document.body.scrollHeight)`);
  await sleep(1600);
  tiles = await evalJs(`document.querySelectorAll('.feed-tile').length`);
  if (tiles >= 110) break;
}
results.scroll100 = { tiles, status: await evalJs(`(document.querySelector('#feed-status')||{}).textContent || ''`) };

// --- 3) first-screen sanity + errors ---
results.firstScreen = await evalJs(`(() => ({
  tiles: document.querySelectorAll('.feed-tile').length,
  broken: [...document.images].filter(i => i.complete && i.naturalWidth === 0).length,
  overflow: document.documentElement.scrollWidth > window.innerWidth
}))()`);
results.consoleErrors = errors;

writeFileSync(`${OUT}/qa2a-followup.json`, JSON.stringify(results, null, 2));
console.log("FOLLOWUP-DONE");
browserWs.ws.close(); page.ws.close(); edge.kill();
process.exit(0);