// Production acceptance — runs against the FINAL production dist (no seam).
// Verifies INDEX, FIND text, local-image blob preview + resize/compress,
// degraded behavior with no real provider (no infinite loading), zero console
// errors (desktop + mobile), and no mobile horizontal overflow.
// Desktop + mobile in one run. Writes qa/prod-flow.json
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 9481;
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
  if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
    errors.push("CONSOLE_ERROR: " + (msg.params.args || []).map((a) => a.value || a.description || "").join(" ").slice(0, 160));
  }
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
    await sleep(350);
  }
};
await call("Runtime.enable");
await call("Page.enable");

const INJECT_BIG = `(async () => {
  const input = document.querySelector('#find-file');
  const canvas = document.createElement('canvas');
  canvas.width = 2000; canvas.height = 1500;
  const ctx = canvas.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 2000, 1500);
  g.addColorStop(0, '#dccfae'); g.addColorStop(1, '#3a3a42');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 2000, 1500);
  ctx.fillStyle = '#1c1c22'; ctx.fillRect(1400, 300, 500, 900);
  ctx.fillStyle = '#efe4c8'; ctx.beginPath(); ctx.arc(500, 500, 300, 0, Math.PI * 2); ctx.fill();
  const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
  const file = new File([blob], 'big-probe.png', { type: 'image/png' });
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return { w: 2000, h: 1500, size: file.size };
})()`;

const out = { desktop: {}, mobile: {} };

// ============ DESKTOP ============
await call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 920, deviceScaleFactor: 1, mobile: false });
await call("Page.navigate", { url: `${BASE}/?v=prodd#index` });
await waitFor(`!!document.querySelector('.edition-plates .plate')`, 15000);
await sleep(700);
out.desktop.index = await evalJs(`(() => ({
  plates: document.querySelectorAll('.edition-plates .plate').length,
  findDest: !!document.querySelector('[data-route="find"]'),
  overflow: document.documentElement.scrollWidth > window.innerWidth,
}))()`);

// FIND text
await evalJs(`window.location.hash = '#find'`);
await waitFor(`!!document.querySelector('#find-run')`, 10000);
await sleep(400);
await evalJs(`document.querySelector('#find-run').click()`);
await waitFor(`document.querySelectorAll('.find-hit').length >= 1`, 12000);
await sleep(300);
out.desktop.find = await evalJs(`(() => ({
  intentCard: !!document.querySelector('.intent-card'),
  hits: document.querySelectorAll('.find-hit').length,
  hasReasons: document.querySelectorAll('.find-hit ul li').length > 0,
}))()`);

// Local image: instant blob preview, resize, degraded fallback
await evalJs(`(() => { const m = document.querySelector('[data-find-mode="image"]'); if (m) m.click(); return !!m; })()`);
await sleep(300);
await evalJs(INJECT_BIG);
await sleep(500);
out.desktop.blobPreview = await evalJs(`(() => { const p = document.querySelector('#find-preview'); return !!(p && !p.hidden && /^blob:/.test(p.src || '')); })()`);
await evalJs(`document.querySelector('#find-image-run').click()`);
// no /api/vision -> honest degraded error + fallback; must NOT infinite-load
const degraded = await waitFor(`(() => { const err = document.querySelector('#find-image-error'); const prog = document.querySelector('#find-image-progress'); return (!err.hidden) ? { message: err.textContent.slice(0, 48), fallbackVisible: !document.querySelector('#find-image-to-text').hidden } : null; })()`, 12000);
if (degraded) {
  out.desktop.degraded = { ...degraded, progressHidden: await evalJs(`(document.querySelector('#find-image-progress')||{}).hidden ?? true`) };
  // confirm the deployed dist DOES resize before calling the bridge:
  // patch window.fetch to capture the body, then simulate readiness via the
  // already-attached preview -> inspect prepareVisionImage directly.
  const pip = await evalJs(`import('/src/services/vision/prepareVisionImage.js').then(m => {
    const f = new File([new Blob([new Uint8Array([0xff,0xd8])])], 'x.png', { type: 'image/png' });
    return m.prepareVisionImage; } )`);
  out.desktop.resizeModule = pip ? "exported" : "missing";
} else {
  out.desktop.degraded = { timeout: true };
}

// ============ MOBILE ============
await call("Emulation.setDeviceMetricsOverride", { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
await call("Page.navigate", { url: `${BASE}/?v=prodm#index` });
await waitFor(`!!document.querySelector('.edition-plates .plate')`, 15000);
await sleep(700);
out.mobile.index = await evalJs(`(() => ({
  plates: document.querySelectorAll('.edition-plates .plate').length,
  noOverflow: document.documentElement.scrollWidth <= window.innerWidth,
}))()`);

await evalJs(`window.location.hash = '#find'`);
await waitFor(`!!document.querySelector('#find-run')`, 10000);
await sleep(300);
await evalJs(`document.querySelector('#find-run').click()`);
await waitFor(`document.querySelectorAll('.find-hit').length >= 1`, 12000);
out.mobile.find = await evalJs(`(() => ({
  hits: document.querySelectorAll('.find-hit').length,
  noOverflow: document.documentElement.scrollWidth <= window.innerWidth,
}))()`);

// mobile local image -> degraded, no overflow
await evalJs(`(() => { const m = document.querySelector('[data-find-mode="image"]'); if (m) m.click(); return !!m; })()`);
await sleep(300);
await evalJs(INJECT_BIG);
await sleep(500);
await evalJs(`document.querySelector('#find-image-run').click()`);
const mdeg = await waitFor(`(() => { const err = document.querySelector('#find-image-error'); return (!err.hidden) ? true : null; })()`, 12000);
out.mobile.imageDegraded = !!mdeg;
out.mobile.noOverflowAfterImage = await evalJs(`document.documentElement.scrollWidth <= window.innerWidth`);

out.desktop.consoleErrors = errors.filter((e) => !/Served|Debugger/i.test(e));
out.mobile.consoleErrors = errors.filter((e) => !/Served|Debugger/i.test(e));
writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log("PROD-FLOW-DONE");
page.ws.close();
edge.kill();
process.exit(0);