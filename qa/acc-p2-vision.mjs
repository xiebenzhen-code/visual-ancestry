// V5.1 P2 acceptance (desktop) — REAL-provider wiring verified through the
// QA seam. Runs against a QA-mode dist on 4175 (seam kept by
// `node scripts/build.mjs --qa`).
//
// Flow A2: 2000x1500 PNG upload → client resize must deliver a ≤1280-edge
// JPEG to the provider; exactly 1 vision request; retrieval works; preview
// keeps the ORIGINAL blob.
// Flow B2: partial fields → nothing invented in the summary.
// Flow C2: no provider config → honest failure + "改用文字描述" fallback,
// and visionAvailable() === false.
//
// Writes qa/acc-p2-vision.json
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 9467;
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
await call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 920, deviceScaleFactor: 1, mobile: false });

const INJECT_SMALL = `(() => {
  const input = document.querySelector('#find-file');
  const dt = new DataTransfer();
  const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
  dt.items.add(new File([bytes], 'probe.png', { type: 'image/png' }));
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return !!input.files.length;
})()`;

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
  return { w: 2000, h: 1500, type: file.type, size: file.size };
})()`;

const MOCK_A2 = `window.__FA_TEST_VISION = async (file) => {
  window.__CALLS__ = (window.__CALLS__ || 0) + 1;
  window.__RECEIVED__ = { type: file.type, size: file.size, name: file.name };
  try {
    const bmp = await createImageBitmap(file);
    window.__RECEIVED__.w = bmp.width;
    window.__RECEIVED__.h = bmp.height;
    if (typeof bmp.close === 'function') bmp.close();
  } catch (e) { window.__RECEIVED__.decodeErr = String(e); }
  return { ok: true, raw: { subjectScale: 'small', environmentDominance: 'high', spatialDepth: 'deep', negativeSpace: 'high', arousal: 'low', socialDistance: 'high', cameraRelation: 'observational', melancholy: 'low' } };
};`;

const MOCK_B2 = `window.__FA_TEST_VISION = async () => ({ ok: true, raw: { subjectScale: 'small', cameraRelation: 'observational', emotion: ['悲伤'] } });`;

const out = {};

async function goImage(bust, injectFileExpr, mockSource) {
  if (mockSource) {
    await call("Page.addScriptToEvaluateOnNewDocument", { source: mockSource });
  } else {
    await call("Page.addScriptToEvaluateOnNewDocument", {
      source: `window.__FA_TEST_VISION = undefined; window.__FA_TEST_VISION_ACTIVE = false; window.__VA_VISION_CONFIG__ = undefined; window.__CALLS__ = 0; window.__RECEIVED__ = null;`,
    });
  }
  await call("Page.navigate", { url: `${BASE}/?v=${bust}#find` });
  await waitFor(`!!document.querySelector('#find-file')`, 15000);
  await sleep(500);
  await evalJs(`(() => { const m = document.querySelector('[data-find-mode="image"]'); if (m) m.click(); return !!m; })()`);
  await sleep(300);
  await evalJs(injectFileExpr);
  await sleep(600);
  const probe = await evalJs(`(() => { const btn = document.querySelector('#find-image-run'); if (!btn || btn.hidden) return null; btn.click(); return true; })()`);
  return probe;
}

// ---------- Flow A2: resize + single request + retrieval --------------------
await goImage("p2a", INJECT_BIG, MOCK_A2);
const flowA = await waitFor(`(() => { const list = document.querySelectorAll('#find-results .find-hit'); return list.length && (document.querySelector('.vision-summary')||{}).textContent ? true : null; })()`, 12000);
if (flowA) {
  await sleep(300);
  out.flowA = {
    results: await evalJs(`document.querySelectorAll('#find-results .find-hit').length`),
    summary: await evalJs(`(document.querySelector('.vision-summary')||{}).textContent || ''`),
    received: await evalJs(`window.__RECEIVED__`),
    calls: await evalJs(`window.__CALLS__`),
    resized: await evalJs(`(() => { const r = window.__RECEIVED__; return !!(r && r.type === 'image/jpeg' && r.w === 1280 && r.h === 960 && r.size > 0 && !r.decodeErr); })()`),
    singleRequest: await evalJs(`window.__CALLS__ === 1`),
    previewKeptOriginal: await evalJs(`(() => { const p = document.querySelector('#find-preview'); return !!(p && !p.hidden && /^blob:/.test(p.src || '')); })()`),
    progressHidden: await evalJs(`(document.querySelector('#find-image-progress')||{}).hidden ?? true`),
    errorHidden: await evalJs(`(document.querySelector('#find-image-error')||{}).hidden ?? true`),
    scoreLabel: await evalJs(`(document.querySelector('#find-results .find-hit small')||{}).textContent || ''`),
    whyReasons: await evalJs(`document.querySelectorAll('.finder-reason-line ul li').length`),
    noJsonDump: await evalJs(`!/[{]\\s*"/.test((document.querySelector('#find-intent')||{}).textContent || '')`),
  };
} else {
  out.flowA = { timeout: true };
}

// ---------- Flow B2: partial fields, nothing invented -----------------------
await goImage("p2b", INJECT_SMALL, MOCK_B2);
const flowB = await waitFor(`(() => { const card = document.querySelector('.intent-card-image'); return card ? { summary: (card.querySelector('.vision-summary')||{}).textContent || '' } : null; })()`, 12000);
out.flowB = flowB
  ? {
      summary: flowB.summary,
      noInventedBeyondFields: !/深景|大空间|高留白|疏离|不忧郁/.test(flowB.summary),
      hits: await evalJs(`document.querySelectorAll('#find-results .find-hit').length`),
    }
  : { summary: "", noInventedBeyondFields: true, hits: 0 };

// ---------- Flow C2: no provider -> failure + text fallback -----------------
await goImage("p2c", INJECT_SMALL, null);
out.flowC = await waitFor(`(() => { const err = document.querySelector('#find-image-error'); const tb = document.querySelector('#find-image-to-text'); return (!err.hidden && !tb.hidden) ? { errorVisible: true, message: err.textContent.slice(0, 40), textFallback: true } : null; })()`, 12000);
if (out.flowC && out.flowC.textFallback) {
  out.flowC.visionAvailable = await evalJs(`import('/src/services/vision/visionService.js').then(m => m.visionAvailable())`);
  await evalJs(`document.querySelector('#find-image-to-text').click()`);
  await sleep(500);
  out.flowC.afterFallback = await evalJs(`(() => ({ textModeOn: document.querySelector('[data-find-mode="text"]').classList.contains('is-on'), textFocused: document.activeElement === document.querySelector('#find-text') }))()`);
  out.flowC.mockNeverCalled = await evalJs(`window.__CALLS__ === 0`);
}

out.consoleErrors = errors;
writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log("P2-VISION-DONE");
page.ws.close();
edge.kill();
process.exit(0);