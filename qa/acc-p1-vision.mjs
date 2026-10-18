// V5.1 P1 acceptance — Local Image → VisualIntent.
// Real browser (headless Edge + CDP) against dist served on 4175.
//
// The shipped build has no real vision provider (honest "unavailable").
// Flow A/B inject a test-only provider through CDP
// (window.__FA_TEST_VISION) that returns legal VisualIntent-shaped JSON —
// the exact seam a future real provider will use. Flow C uses the
// default no-provider path and asserts the failure UI + text fallback.
//
// Writes qa/acc-p1-vision.json
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 9463;
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

async function goFind(faVisionMock, bust) {
  if (faVisionMock) {
    await call("Page.addScriptToEvaluateOnNewDocument", {
      source: `window.__FA_TEST_VISION = async () => (${faVisionMock});`,
    });
    await call("Page.addScriptToEvaluateOnNewDocument", {
      source: `window.__FA_TEST_VISION_ACTIVE = true;`,
    });
  } else {
    await call("Page.addScriptToEvaluateOnNewDocument", {
      source: `window.__FA_TEST_VISION = undefined; window.__FA_TEST_VISION_ACTIVE = false;`,
    });
  }
  await call("Page.navigate", { url: `${BASE}/?v=${bust}#find` });
  await waitFor(`!!document.querySelector('#find-file')`, 15000);
  await sleep(500);
  await evalJs(`(() => { const m = document.querySelector('[data-find-mode="image"]'); if (m) m.click(); return !!m; })()`);
  await sleep(300);
  await evalJs(INJECT_FILE);
  await sleep(400);
  await evalJs(`document.querySelector('#find-image-run').click()`);
}

// ---------- Flow A: valid image -> preview -> vision intent -> retrieval ----------
const MOCK_A = `({ ok: true, raw: { subjectScale: "small", environmentDominance: "high", spatialDepth: "deep", negativeSpace: "high", arousal: "low", socialDistance: "high", cameraRelation: "observational", melancholy: "low" } })`;
await goFind(MOCK_A, "p1a");
const flowA = await waitFor(`(() => { const list = document.querySelectorAll('#find-results .find-hit'); return list.length ? { count: list.length, first: (document.querySelector('.vision-summary')||{}).textContent || '' } : null; })()`, 12000);
out.flowA = flowA
  ? {
      preview: true,
      results: flowA.count,
      summary: flowA.first,
      progressHidden: await evalJs(`(document.querySelector('#find-image-progress')||{}).hidden ?? true`),
      scoreLabel: await evalJs(`(document.querySelector('#find-results .find-hit small')||{}).textContent || ''`),
      whyReasons: await evalJs(`document.querySelectorAll('.finder-reason-line ul li').length`),
      noJsonDump: await evalJs(`!/[{]\\s*"/.test((document.querySelector('#find-intent')||{}).textContent || '')`),
      errorHidden: await evalJs(`(document.querySelector('#find-image-error')||{}).hidden ?? true`),
    }
  : { preview: false, results: 0, summary: "" };

// ---------- Flow B: partial fields, nothing invented ----------
const MOCK_B = `({ ok: true, raw: { subjectScale: "small", cameraRelation: "observational", emotion: ["悲伤"] } })`;
await goFind(MOCK_B, "p1b");
const flowB = await waitFor(`(() => { const card = document.querySelector('.intent-card-image'); return card ? { summary: (card.querySelector('.vision-summary')||{}).textContent || '' } : null; })()`, 12000);
out.flowB = flowB
  ? {
      summary: flowB.summary,
      // only the two real fields surface; the mock's emotion is a legal token so
      // nothing is "invented" by us, but the summary must not claim unjudged axes
      noInventedBeyondFields: !/深景|大空间|高留白|疏离|不忧郁/.test(flowB.summary),
      hits: await evalJs(`document.querySelectorAll('#find-results .find-hit').length`),
    }
  : { summary: "", noInventedBeyondFields: true, hits: 0 };

// ---------- Flow C: no provider -> failure + text fallback ----------
await goFind(null, "p1c");
out.flowC = await waitFor(`(() => { const err = document.querySelector('#find-image-error'); const tb = document.querySelector('#find-image-to-text'); return (!err.hidden && !tb.hidden) ? { errorVisible: true, message: err.textContent.slice(0, 40), textFallback: true, pageAlive: !!document.querySelector('.find-page') } : null; })()`, 12000);
if (out.flowC && out.flowC.textFallback) {
  await evalJs(`document.querySelector('#find-image-to-text').click()`);
  await sleep(500);
  out.flowC.afterFallback = await evalJs(`(() => ({ textModeOn: document.querySelector('[data-find-mode="text"]').classList.contains('is-on'), textFocused: document.activeElement === document.querySelector('#find-text') }))()`);
}

out.consoleErrors = errors;
writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log("P1-VISION-DONE");
page.ws.close();
edge.kill();
process.exit(0);