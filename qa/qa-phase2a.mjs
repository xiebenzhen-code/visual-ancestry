// qa-phase2a.mjs — full Step 7 acceptance over the built dist at 127.0.0.1:4175.
// Desktop: first screen, dense feed, hover meta, 100+ continuous scroll,
// search focus retention, detail->back scroll restoration.
// Mobile (390x844): no horizontal overflow, continuous load, Chinese input,
// detail enter/back, thumb-vs-detail tier check, rapid scroll stability.
// Search matrix: local / remote / merged counts + dedup.
// Image pipeline: eager count, lazy, srcset, fallback chain, 0 broken.
// Regression: CREATE / SHOOT entry for curated works.
// All results written to qa/qa2a-results.json; screenshots to qa/.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 9425;
const BASE = "http://127.0.0.1:4175";
const OUT = "C:<local-path>";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PROFILE = process.cwd() + "\\work\\edge-qa2a";

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

// --- boot browser ---
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
  if (msg.method === "Runtime.exceptionThrown") {
    errors.push("EXC: " + (msg.params?.exceptionDetails?.text || "?"));
  }
  if (msg.method === "Runtime.consoleAPICalled" && ["error"].includes(msg.params?.type)) {
    const text = (msg.params?.args || []).map((a) => a.value ?? a.description ?? "").join(" ");
    errors.push("CONSOLE-ERR: " + text.slice(0, 300));
  }
});
const call = page.send;

const evalJs = async (expr) => {
  const r = await call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { __err: (r.result.exceptionDetails.text || "") + " " + JSON.stringify(r.result.exceptionDetails.exception?.description || "").slice(0, 200) };
  return r.result?.result?.value;
};
const setViewport = (w, h) => call("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: w < 700 });
const nav = async (hash, wait = 3500) => {
  await call("Page.navigate", { url: `${BASE}/#${hash}` });
  await sleep(wait);
};
const shot = async (name) => {
  const s = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(s.result.data, "base64"));
};

await call("Runtime.enable");
await call("Page.enable");

// ============ DESKTOP ============
await setViewport(1440, 920);

// 1) first screen + image pipeline attributes
await nav("index", 4500);
results.desktop_first = await evalJs(`(() => ({
  tiles: document.querySelectorAll('.feed-tile').length,
  eager: [...document.querySelectorAll('.feed-tile img')].filter(i => i.loading === 'eager').length,
  lazy: [...document.querySelectorAll('.feed-tile img')].filter(i => i.loading === 'lazy').length,
  withSrcset: [...document.querySelectorAll('.feed-tile img')].filter(i => i.srcset).length,
  withFallback: [...document.querySelectorAll('.feed-tile img')].filter(i => i.dataset.fallbackChain).length,
  broken: [...document.images].filter(i => i.complete && i.naturalWidth === 0).length,
  meta: document.querySelectorAll('.feed-tile .feed-meta').length,
  overflow: document.documentElement.scrollWidth > window.innerWidth,
  firstSrc: (document.querySelector('.feed-tile img')||{}).src || '',
  firstChain: (document.querySelector('.feed-tile img')||{}).dataset?.fallbackChain?.split('|').slice(0,2).join(' > ') || ''
}))()`);
await shot("qa2a-desktop-feed");

// 2) continuous scroll >= 100 items
let maxTiles = results.desktop_first.tiles;
for (let i = 0; i < 14 && maxTiles < 110; i++) {
  await evalJs(`window.scrollTo(0, document.body.scrollHeight)`);
  await sleep(1800);
  maxTiles = await evalJs(`document.querySelectorAll('.feed-tile').length`);
}
results.desktop_scroll = { tiles: maxTiles, status: await evalJs(`(document.querySelector('#feed-status')||{}).textContent || ''`) };

// 3) detail -> back scroll restoration
await evalJs(`window.scrollTo(0, 900)`);
await sleep(500);
const beforeY = await evalJs(`window.scrollY`);
const firstHref = await evalJs(`(document.querySelector('.feed-tile')||{href:''}).href`);
await call("Page.navigate", { url: firstHref });
await sleep(2500);
await call("Page.navigate", { url: `${BASE}/#index` });
await sleep(1200);
const afterY = await evalJs(`window.scrollY`);
results.desktop_scrollRestore = { beforeY, afterY, delta: Math.abs(afterY - beforeY) };

// 4) search focus retention
await nav("search", 1500);
const focusAfterRender = await evalJs(`document.activeElement && document.activeElement.id`);
await evalJs(`(() => { const i = document.querySelector('#main-search'); i.value = 'Vermeer'; i.dispatchEvent(new Event('input',{bubbles:true})); return 1; })()`);
await sleep(12000); // wait debounce + remote fetch
const searchLabelAfter = await evalJs(`(document.querySelector('#result-label')||{}).textContent || ''`);
const searchTiles = await evalJs(`document.querySelectorAll('#feed-grid .feed-tile').length`);
const firstResHref = await evalJs(`(document.querySelector('#feed-grid .feed-tile')||{href:''}).href`);
await call("Page.navigate", { url: firstResHref });
await sleep(2200);
await call("Page.navigate", { url: `${BASE}/#search` });
await sleep(1200);
const focusAfterBack = await evalJs(`document.activeElement && document.activeElement.id`);
results.desktop_search = { focusAfterRender, label: searchLabelAfter, tiles: searchTiles, focusAfterBack };

// ============ SEARCH MATRIX ============
const QUERIES = ["Vermeer", "Hopper", "水墨", "ink wash", "浮世绘", "ukiyo-e", "Romanticism"];
results.searchMatrix = {};
for (const q of QUERIES) {
  await nav("search", 1000);
  await evalJs(`(() => { const i = document.querySelector('#main-search'); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event('input',{bubbles:true})); return 1; })()`);
  await sleep(12000);
  const data = await evalJs(`(() => {
    const tiles = [...document.querySelectorAll('#feed-grid .feed-tile')];
    const keys = tiles.map(t => t.href.split('#artwork/')[1]);
    const seen = new Set();
    const dups = keys.filter(k => seen.size === seen.add(k).size);
    return {
      label: (document.querySelector('#result-label')||{}).textContent || '',
      tiles: tiles.length,
      dupKeys: [...new Set(dups)],
      firstHref: (tiles[0]?.href || ''),
    };
  })()`);
  // try to parse local / remote from label
  let local = null, remote = null;
  const m = /本地\s*(\d+)/.exec(data.label);
  if (m) local = Number(m[1]);
  const m2 = /四馆\s*(\d+)/.exec(data.label);
  if (m2) remote = Number(m2[1]);
  results.searchMatrix[q] = { label: data.label, tiles: data.tiles, local, remote, dupKeys: data.dupKeys, firstHref: data.firstHref };
}

// ============ MOBILE ============
await setViewport(390, 844);

await nav("index", 4000);
results.mobile_first = await evalJs(`(() => ({
  tiles: document.querySelectorAll('.feed-tile').length,
  overflow: document.documentElement.scrollWidth > window.innerWidth,
  broken: [...document.images].filter(i => i.complete && i.naturalWidth === 0).length
}))()`);

// rapid scroll stability
for (let i = 0; i < 8; i++) {
  await evalJs(`window.scrollTo(0, ${i % 2 ? 0 : 2000})`);
  await sleep(400);
}
await sleep(1800);
results.mobile_rapidScroll = await evalJs(`(() => ({
  tiles: document.querySelectorAll('.feed-tile').length,
  overflow: document.documentElement.scrollWidth > window.innerWidth,
  responsive: document.readyState
}))()`);

// continuous load mobile
let mobTiles = results.mobile_first.tiles;
for (let i = 0; i < 12 && mobTiles < 70; i++) {
  await evalJs(`window.scrollTo(0, document.body.scrollHeight)`);
  await sleep(1600);
  mobTiles = await evalJs(`document.querySelectorAll('.feed-tile').length`);
}
results.mobile_scroll = { tiles: mobTiles };

// thumbnail tier correctness (mobile srcset picks thumb at small widths)
results.mobile_tier = await evalJs(`(() => {
  const img = document.querySelector('.feed-tile img');
  return { srcset: img ? img.srcset.slice(0, 120) : '', chain: img ? (img.dataset.fallbackChain||'').split('|')[0] : '' };
})()`);
await shot("qa2a-mobile-feed");

// mobile detail enter/back
await nav("artwork/local:wave", 3500);
results.mobile_detail = await evalJs(`(() => ({
  h1: (document.querySelector('.detail-head h1')||{}).textContent?.replace(/\\s+/g,' ').trim() || '',
  facts: !!document.querySelector('.detail-facts'),
  dna: !!document.querySelector('.dna-tags'),
  similar: document.querySelectorAll('.similar-grid .feed-tile').length,
  overflow: document.documentElement.scrollWidth > window.innerWidth
}))()`);
await shot("qa2a-mobile-detail");

// mobile Chinese search
await nav("search", 1000);
await setViewport(390, 844);
await call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await evalJs(`(() => { const i = document.querySelector('#main-search'); i.value = '水墨'; i.dispatchEvent(new Event('input',{bubbles:true})); return 1; })()`);
await sleep(4000);
results.mobile_cn = await evalJs(`(() => ({
  label: (document.querySelector('#result-label')||{}).textContent || '',
  tiles: document.querySelectorAll('#feed-grid .feed-tile').length,
  overflow: document.documentElement.scrollWidth > window.innerWidth
}))()`);

// ============ REGRESSION: CREATE / SHOOT ============
await setViewport(1440, 920);
await nav("create/wanderer", 3200);
results.regression_create = await evalJs(`(() => ({
  sections: document.querySelectorAll('.analysis-section').length,
  promptFields: document.querySelectorAll('.field-block').length,
  combineBtn: !!document.querySelector('#combine-prompt'),
  filmRows: document.querySelectorAll('.film-ref-row').length
}))()`);
await nav("shoot/wanderer", 3200);
results.regression_shoot = await evalJs(`(() => ({
  subjectBadge: (document.querySelector('.subject-badge')||{}).textContent || '',
  guideRows: document.querySelectorAll('.camera-guide div').length,
  overlayToggle: !!document.querySelector('[data-overlay-toggle]'),
  locationCards: document.querySelectorAll('.location-card').length
}))()`);

results.consoleErrors = errors;

// save
writeFileSync(`${OUT}/qa2a-results.json`, JSON.stringify(results, null, 2));
console.log("QA2A-DONE");
browserWs.ws.close();
page.ws.close();
edge.kill();
process.exit(0);