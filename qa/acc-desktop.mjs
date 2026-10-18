// Phase 2A.5 acceptance — desktop four tasks. Writes qa/qa2a5-desktop.json.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 9460;
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
await call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 920, deviceScaleFactor: 1, mobile: false });

const out = {};
await call("Page.navigate", { url: `${BASE}/?v=3#index` });
await waitFor(`!!document.querySelector('.hero')`, 15000);
await sleep(1000);

// 1) hero
out.hero = await evalJs(`(() => ({
  kicker: (document.querySelector('.hero-kicker')||{}).textContent || '',
  h1: (document.querySelector('.hero h1')||{}).textContent || '',
  entries: [...document.querySelectorAll('.hero-entry')].map(a => a.textContent.replace(/\\s+/g,' ').trim()),
  hasSearch: !!document.querySelector('#hero-search-input'),
  tilesInViewport: [...document.querySelectorAll('.feed-tile')].filter(t => t.getBoundingClientRect().top < window.innerHeight).length,
  totalTiles: document.querySelectorAll('.feed-tile').length,
  overflow: document.documentElement.scrollWidth > window.innerWidth,
}))()`);

// 2) live search feedback
await evalJs(`(() => { const i = document.querySelector('#hero-search-input'); i.value='水墨'; i.dispatchEvent(new Event('input',{bubbles:true})); return 1; })()`);
await sleep(300);
const early = await evalJs(`(document.querySelector('#hero-search-status')||{}).textContent || ''`);
await sleep(2500);
const late = await evalJs(`(() => ({ status: (document.querySelector('#hero-search-status')||{}).textContent || '', results: document.querySelectorAll('#hero-search-results .sresult').length }))()`);
out.search = { early, ...late };

// 3) no match
await evalJs(`(() => { const i = document.querySelector('#hero-search-input'); i.value='qqqqzzzz'; i.dispatchEvent(new Event('input',{bubbles:true})); return 1; })()`);
await sleep(1500);
out.noMatch = await evalJs(`(() => ({ status: (document.querySelector('#hero-search-status')||{}).textContent || '', chips: document.querySelectorAll('#hero-search-chips [data-sug]').length }))()`);

// 4) tile actions + detail
await evalJs(`(() => { const i = document.querySelector('#hero-search-input'); i.value=''; i.dispatchEvent(new Event('input',{bubbles:true})); return 1; })()`);
await sleep(600);
const actions = await evalJs(`[...document.querySelectorAll('.feed-tile .tile-actions button')].slice(0, 3).map(a => a.textContent.trim())`);
await evalJs(`window.location.hash = document.querySelector('.feed-tile .tile-link').getAttribute('href').replace('#','')`);
await waitFor(`!!document.querySelector('.detail-head h1')`, 12000);
await sleep(800);
const detail = await evalJs(`(() => ({ h1: (document.querySelector('.detail-head h1')||{}).textContent?.replace(/\\s+/g,' ').trim() || '', actions: [...document.querySelectorAll('.detail-actionsrow a')].map(a => a.textContent.trim()), facts: !!document.querySelector('.detail-facts'), dna: !!document.querySelector('.dna-tags') }))()`);
out.detail = { actions, detail };

// 5) two steps to create
await evalJs(`(() => { const a = document.querySelector('[data-detail-action="create"]'); if (a) a.click(); return !!a; })()`);
await waitFor(`!!document.querySelector('.workspace-steps')`, 12000);
await sleep(800);
out.create = await evalJs(`(() => ({ hash: location.hash, steps: [...document.querySelectorAll('.workspace-steps li')].map(li => li.textContent.trim()), promptFields: document.querySelectorAll('.prompt-grid .field-block').length, combine: !!document.querySelector('#combine-prompt') }))()`);

// 6) shoot wizard
await call("Page.navigate", { url: `${BASE}/#shoot` });
await waitFor(`!!document.querySelector('.subject-card')`, 12000);
await sleep(600);
const wiz = await evalJs(`(() => ({ subjectCards: document.querySelectorAll('.subject-card').length, subjects: [...document.querySelectorAll('.subject-card span:first-child')].map(s => s.textContent.trim()) }))()`);
await evalJs(`document.querySelector('[data-subject="PERSON"]').click()`);
await waitFor(`!!document.querySelector('#shoot-mood-chips [data-mood]')`, 8000);
const moods = await evalJs(`document.querySelectorAll('#shoot-mood-chips [data-mood]').length`);
await evalJs(`(() => { const b = document.querySelector('#shoot-mood-chips [data-mood]'); if (b) b.click(); return !!b; })()`);
await waitFor(`!!document.querySelector('#shoot-works-grid .art-tile')`, 8000);
const works = await evalJs(`document.querySelectorAll('#shoot-works-grid .art-tile').length`);
await evalJs(`(() => { const t = document.querySelector('#shoot-works-grid .art-tile'); if (t) t.click(); return !!t; })()`);
await waitFor(`!!document.querySelector('[data-overlay-toggle]')`, 12000);
await sleep(800);
const guide = await evalJs(`(() => ({ overlayToggle: !!document.querySelector('[data-overlay-toggle]'), guideRows: document.querySelectorAll('.camera-guide div').length, subjectBadge: (document.querySelector('.subject-badge')||{}).textContent || '' }))()`);
out.shoot = { wiz, moods, works, guide };

out.consoleErrors = errors;
writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log("DESKTOP-ACC-DONE");
page.ws.close();
edge.kill();
process.exit(0);