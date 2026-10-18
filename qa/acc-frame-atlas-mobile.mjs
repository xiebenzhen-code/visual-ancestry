// Frame Atlas — mobile acceptance (375 viewport). Same six flows, mobile breakpoints.
// Writes qa/acc-frame-atlas-mobile.json.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 9462;
const BASE = "http://127.0.0.1:4175";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PROFILE = "C:<local-path>";
const OUT = "C:<local-path>";

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
const errors = [];
const created = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
const page = await cdpConnect(created.webSocketDebuggerUrl, (msg) => {
  if (msg.method === "Runtime.exceptionThrown") errors.push("EXC: " + (msg.params?.exceptionDetails?.text || "?"));
});
const call = page.send;
const evalJs = async (expr) => {
  const r = await call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.text || "" };
  return r.result?.result?.value;
};
const waitFor = async (expr, timeoutMs = 15000) => {
  const start = Date.now();
  for (;;) {
    const v = await evalJs(expr);
    if (v) return v;
    if (Date.now() - start > timeoutMs) return null;
    await sleep(400);
  }
};
await call("Runtime.enable");
await call("Page.enable");
await call("Emulation.setDeviceMetricsOverride", { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });

const out = {};
await call("Page.navigate", { url: `${BASE}/?v=fam1#index` });
await waitFor(`!!document.querySelector('.edition-plates .plate')`, 15000);
await sleep(900);
out.home = await evalJs(`(() => ({
  plates: document.querySelectorAll('.edition-plates .plate').length,
  destinationsOneColumn: (() => { const d = document.querySelector('.edition-destinations'); const a = document.querySelector('.destination'); if (!d || !a) return false; return a.getBoundingClientRect().width >= d.getBoundingClientRect().width - 2; })(),
  menuTrigger: !!document.querySelector('#mobile-menu-trigger'),
  overflow: document.documentElement.scrollWidth > window.innerWidth,
  verbs: [...document.querySelectorAll('.edition-destinations .destination .name')].map(n => n.textContent.trim()),
}))()`);

await evalJs(`window.location.hash = '#find'`);
await waitFor(`!!document.querySelector('#find-run')`, 12000);
await sleep(600);
await evalJs(`document.querySelector('#find-run').click()`);
await waitFor(`document.querySelectorAll('.find-hit').length >= 1`, 12000);
await sleep(400);
out.find = await evalJs(`(() => ({
  intentCard: !!document.querySelector('.intent-card'),
  hits: document.querySelectorAll('.find-hit').length,
  hitOverflow: [...document.querySelectorAll('.find-hit')].some(a => a.getBoundingClientRect().right > window.innerWidth + 1),
}))()`);

await evalJs(`(() => { const a = document.querySelector('.find-hit'); if (a) a.click(); return !!a; })()`);
await waitFor(`!!document.querySelector('.detail-head h1')`, 12000);
await sleep(600);
out.detail = await evalJs(`(() => ({
  bigImage: !!document.querySelector('.detail-figure img[src]'),
  actions: [...document.querySelectorAll('.detail-actionsrow a')].map(a => a.textContent.trim()),
  relations: document.querySelectorAll('#visual-relations .relation-row').length,
}))()`);

await evalJs(`window.location.hash = '#shoot'`);
await waitFor(`!!document.querySelector('.subject-card')`, 12000);
await sleep(500);
out.shoot = await evalJs(`(() => ({
  subjectCards: document.querySelectorAll('.subject-card').length,
  refLinks: document.querySelectorAll('.create-picks a[href^="#shoot/"]').length,
  overflow: document.documentElement.scrollWidth > window.innerWidth,
}))()`);

await evalJs(`window.location.hash = '#find'`);
await waitFor(`!!document.querySelector('[data-find-mode="image"]')`, 12000);
await sleep(400);
await evalJs(`(() => { const m = document.querySelector('[data-find-mode="image"]'); if (m) m.click(); return !!m; })()`);
await sleep(300);
await evalJs(`(() => {
  const input = document.querySelector('#find-file');
  const dt = new DataTransfer();
  const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
  dt.items.add(new File([bytes], 'probe.png', { type: 'image/png' }));
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return 1;
})()`);
await sleep(500);
out.localImage = await evalJs(`(() => ({ visible: (() => { const p = document.querySelector('#find-preview'); return !!p && !p.hidden && p.src.startsWith('blob:'); })() }))()`);

out.consoleErrors = errors;
writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log("FRAME-ATLAS-MOBILE-DONE");
page.ws.close();
edge.kill();
process.exit(0);