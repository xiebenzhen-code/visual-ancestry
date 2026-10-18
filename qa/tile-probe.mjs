// Probe the rendered tile markup on the live server.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
const PORT = 9455;
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PROFILE = "C:<local-path>";
async function cdpConnect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws")); });
  let id = 0; const pending = new Map();
  ws.onmessage = (ev) => { const msg = JSON.parse(ev.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } };
  const send = (method, params = {}) => new Promise((resolve) => { const mid = ++id; pending.set(mid, resolve); ws.send(JSON.stringify({ id: mid, method, params })); });
  return { ws, send };
}
const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, "--no-first-run", "about:blank"], { stdio: "ignore" });
let version = null;
for (let i = 0; i < 40 && !version; i++) { try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch {} if (!version) await sleep(700); }
const created = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
const page = await cdpConnect(created.webSocketDebuggerUrl);
const call = page.send;
await call("Runtime.enable"); await call("Page.enable");
await call("Page.navigate", { url: "http://127.0.0.1:4175/?v=2#index" });
await sleep(6000);
const r = await call("Runtime.evaluate", { expression: `(() => { const t = document.querySelector('.feed-tile'); const h = t ? t.outerHTML : 'NO TILE'; return { tileCount: document.querySelectorAll('.feed-tile').length, actionCount: document.querySelectorAll('.tile-actions').length, btnCount: document.querySelectorAll('.feed-tile button').length, html: h.slice(h.length - 900) } })()`, returnByValue: true });
writeFileSync("C:<local-path>", JSON.stringify(r.result?.result?.value ?? { raw: JSON.stringify(r.result).slice(0, 400) }, null, 2));
console.log("DONE");
page.ws.close(); edge.kill(); process.exit(0);