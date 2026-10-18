// V5.1 P1 mobile acceptance (Flow D) + core regression subset.
// Writes qa/acc-p1-vision-mobile.json
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 9464;
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
    await sleep(350);
  }
};
await call("Runtime.enable");
await call("Page.enable");
await call("Emulation.setDeviceMetricsOverride", { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });

const MOCK_FULL = `({ ok: true, raw: { subjectScale: "small", environmentDominance: "high", spatialDepth: "deep", negativeSpace: "high", arousal: "low", socialDistance: "high", cameraRelation: "observational" } })`;
await call("Page.addScriptToEvaluateOnNewDocument", {
  source: `window.__FA_TEST_VISION = async () => (${MOCK_FULL});`,
});

const INJECT_FILE = `(() => {
  const input = document.querySelector('#find-file');
  const dt = new DataTransfer();
  const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
  dt.items.add(new File([bytes], 'probe.png', { type: 'image/png' }));
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return !!input.files.length;
})()`;

const out = {};

// ---------- Flow D: mobile image upload, single column, no overflow ----------
await call("Page.navigate", { url: `${BASE}/?v=p1m#find` });
await waitFor(`!!document.querySelector('#find-file')`, 15000);
await sleep(500);
await evalJs(`(() => { const m = document.querySelector('[data-find-mode="image"]'); if (m) m.click(); return !!m; })()`);
await sleep(300);
await evalJs(INJECT_FILE);
await sleep(400);
await evalJs(`document.querySelector('#find-image-run').click()`);
const flowD = await waitFor(`(() => { const list = document.querySelectorAll('#find-results .find-hit'); return list.length ? true : false; })()`, 12000);
if (flowD) {
  await sleep(400);
  out.flowD = await evalJs(`(() => {
    const hits = [...document.querySelectorAll('#find-results .find-hit')];
    const rects = hits.map(a => a.getBoundingClientRect());
    const lefts = rects.map(r => Math.round(r.left));
    const tops = rects.map(r => Math.round(r.top));
    // single column: all cards share the same left edge AND stack vertically
    const sameLeft = new Set(lefts).size === 1;
    const stacked = new Set(tops).size === rects.length;
    return {
      hits: hits.length,
      singleColumn: sameLeft && stacked,
      noOverflow: document.documentElement.scrollWidth <= window.innerWidth,
      summaryVisible: !!(document.querySelector('.vision-summary')||{}).textContent,
      previewVisible: (() => { const p = document.querySelector('#find-preview'); return !!p && !p.hidden; })(),
    };
  })()`);
}

// ---------- Core regression subset (mobile): homepage + text FIND ----------
await call("Page.navigate", { url: `${BASE}/?v=p1m2#index` });
await waitFor(`!!document.querySelector('.edition-plates .plate')`, 15000);
await sleep(800);
out.regressionHome = await evalJs(`(() => ({
  plates: document.querySelectorAll('.edition-plates .plate').length,
  verbs: [...document.querySelectorAll('.edition-destinations .destination .name')].map(n => n.textContent.trim()),
  overflow: document.documentElement.scrollWidth > window.innerWidth,
}))()`);

await evalJs(`window.location.hash = '#find'`);
await waitFor(`!!document.querySelector('#find-run')`, 12000);
await sleep(400);
await evalJs(`document.querySelector('#find-run').click()`);
await waitFor(`document.querySelectorAll('.find-hit').length >= 1`, 12000);
await sleep(300);
out.regressionTextFind = await evalJs(`(() => ({
  intentCard: !!document.querySelector('.intent-card'),
  hits: document.querySelectorAll('.find-hit').length,
  hasReasons: document.querySelectorAll('.find-hit ul li').length > 0,
}))()`);

out.consoleErrors = errors;
writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log("P1-MOBILE-DONE");
page.ws.close();
edge.kill();
process.exit(0);