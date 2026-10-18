// Frame Atlas core rebuild — desktop acceptance, 6 required flows.
//  1. Homepage: 3-5 curated plates (image-only, ratio-mixed, no keyword wall)
//  2. FIND: intent -> relations -> reasons (sample query, retrieval score labels)
//  3. Detail: two steps into using images (FIND SIMILAR / CREATE WITH THIS / SHOOT LIKE THIS)
//  4. CREATE: multi-reference language sheet -> structured prompt
//  5. SHOOT: reference-first three-step wizard + overlay
//  6. Local image instant preview (FIND image mode, DataTransfer file)
// Plus: global search overlay (⌕). Writes qa/acc-frame-atlas.json.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 9461;
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

// ---------- 1) Homepage ----------
await call("Page.navigate", { url: `${BASE}/?v=fa1#index` });
await waitFor(`!!document.querySelector('.edition-plates .plate')`, 15000);
await sleep(900);
out.home = await evalJs(`(() => {
  const plates = [...document.querySelectorAll('.edition-plates .plate')];
  const ratios = plates.map(a => (a.querySelector('.img-slot')||{}).getAttribute?.('style') || '');
  return {
    plates: plates.length,
    inRange: plates.length >= 3 && plates.length <= 5,
    images: plates.filter(a => !!a.querySelector('img[src]')).length,
    hasKeywordWall: document.querySelectorAll('.feed-tile, .hero-entry, .hero').length > 0,
    hasSaaSButtons: /登录|注册|试用|pricing/i.test(document.body.innerText.slice(0, 800)),
    ratioMix: new Set(ratios).size,
    verbs: [...document.querySelectorAll('.edition-destinations .destination .name')].map(n => n.textContent.trim()),
    numbers: [...document.querySelectorAll('.edition-destinations .destination .no')].map(n => n.textContent.trim()),
    overflow: document.documentElement.scrollWidth > window.innerWidth,
  };
})()`);

// ---------- 2) FIND: intent -> relations -> reasons ----------
await evalJs(`window.location.hash = '#find'`);
await waitFor(`!!document.querySelector('#find-run')`, 12000);
await sleep(600);
await evalJs(`document.querySelector('#find-run').click()`);
await waitFor(`document.querySelectorAll('.find-hit').length >= 1`, 12000);
await sleep(500);
out.find = await evalJs(`(() => {
  const intentText = (document.querySelector('.intent-card')||{}).textContent || '';
  const hits = [...document.querySelectorAll('.find-hit')];
  const first = hits[0];
  return {
    intentCard: !!document.querySelector('.intent-card'),
    hasScaleSmall: intentText.includes('subjectScale: small'),
    hasEnvHigh: intentText.includes('environmentDominance: high'),
    hasDepthDeep: intentText.includes('spatialDepth: deep'),
    hasNegSpace: intentText.includes('negativeSpace: high'),
    hasArousalLow: intentText.includes('arousal: low'),
    hasSocialHigh: intentText.includes('socialDistance: high'),
    hasMelancholyLow: intentText.includes('melancholy: low'),
    hasCameraObs: intentText.includes('cameraRelation: observational'),
    notSadFiltered: !intentText.includes('emotion: 悲伤') && !intentText.includes('孤独'),
    hitCount: hits.length,
    scoreLabel: (first?.querySelector('small')||{}).textContent || '',
    firstReasons: first ? first.querySelectorAll('ul li').length : 0,
    usesAiLanguage: /AI similarity|语义确定性|AI 相似度/i.test((first?.textContent || '')),
  };
})()`);

// ---------- 3) Detail: two steps into using images ----------
await evalJs(`(() => { const a = document.querySelector('.find-hit'); if (a) a.click(); return !!a; })()`);
await waitFor(`!!document.querySelector('.detail-head h1')`, 12000);
await sleep(700);
const detailFirst = await evalJs(`(() => ({
  h1: (document.querySelector('.detail-head h1')||{}).textContent?.replace(/\\s+/g,' ').trim() || '',
  actions: [...document.querySelectorAll('.detail-actionsrow a')].map(a => a.textContent.trim()),
  whyItWorks: !!document.querySelector('.analysis-section .section-title') && /WHY IT WORKS/.test(document.querySelector('.detail-body').textContent),
  relations: document.querySelectorAll('#visual-relations .relation-row').length,
  relationsReasons: document.querySelectorAll('#visual-relations .relation-row ul li').length,
  cinema: document.querySelectorAll('.seen-in-cinema .film-ref-row').length,
  facts: !!document.querySelector('.detail-facts'),
  bigImage: !!document.querySelector('.detail-figure img[src]'),
}))()`);

// FIND SIMILAR scrolls to relations (stays on page)
await evalJs(`document.querySelector('[data-detail-action="similar"]').click()`);
await sleep(900);
const similarScroll = await evalJs(`(() => {
  const rel = document.querySelector('#visual-relations');
  if (!rel) return false;
  const r = rel.getBoundingClientRect();
  return r.top >= -40 && r.top < window.innerHeight * 0.6;
})()`);

// CREATE WITH THIS -> create with artwork pre-selected
await evalJs(`document.querySelector('[data-detail-action="create"]').click()`);
await waitFor(`!!document.querySelector('#create-language') || !!document.querySelector('.create-picks')`, 12000);
await sleep(600);
const createPreselect = await evalJs(`(() => ({
  hash: location.hash,
  preselected: document.querySelectorAll('.create-picks button.is-on').length,
  picksShown: document.querySelectorAll('.create-picks button').length,
}))()`);

// add a second reference -> language sheet -> prompt
await evalJs(`(() => { const b = document.querySelector('.create-picks button:not(.is-on)'); if (b) b.click(); return !!b; })()`);
await waitFor(`!!document.querySelector('.language-sheet')`, 12000);
await sleep(600);
const language = await evalJs(`(() => ({
  lines: document.querySelectorAll('.language-line').length,
  lineTexts: [...document.querySelectorAll('.language-line strong')].map(s => s.textContent.trim()),
  keepBoxes: document.querySelectorAll('[data-keep]').length,
}))()`);
await evalJs(`document.querySelector('#make-prompt').click()`);
await sleep(400);
const promptBlocks = await evalJs(`(() => ({
  blocks: document.querySelectorAll('#made-prompt .field-block').length,
  blockText: (document.querySelector('#made-prompt')||{}).textContent?.replace(/\\s+/g,' ').trim().slice(0, 120) || '',
}))()`);
out.detail = { detailFirst, similarScroll, createPreselect, language, promptBlocks };

// ---------- 4) CREATE: multi-reference language -> prompt (from scratch) ----------
await evalJs(`window.location.hash = '#create'`);
await waitFor(`!!document.querySelector('.create-picks button')`, 12000);
await sleep(500);
await evalJs(`(() => { [...document.querySelectorAll('.create-picks button')].slice(0, 2).forEach(b => { if (!b.classList.contains('is-on')) b.click(); }); return 1; })()`);
await waitFor(`!!document.querySelector('.language-sheet')`, 12000);
await sleep(500);
await evalJs(`document.querySelector('#make-prompt').click()`);
await sleep(400);
out.create = await evalJs(`(() => ({
  lines: document.querySelectorAll('.language-line').length,
  blocks: document.querySelectorAll('#made-prompt .field-block').length,
  hasComposition: !!document.querySelector('#made-prompt') && /Composition|Scene|Lighting|Camera|Movement|Negative/.test(document.querySelector('#made-prompt').textContent),
  perArtworkNotes: document.querySelectorAll('.language-line em').length,
}))()`);

// ---------- 5) SHOOT: reference-first, three-step wizard ----------
await evalJs(`window.location.hash = '#shoot'`);
await waitFor(`!!document.querySelector('.subject-card')`, 12000);
await sleep(600);
const shootRefs = await evalJs(`(() => ({
  refLinks: document.querySelectorAll('.create-picks a[href^="#shoot/"]').length,
  localDrop: !!document.querySelector('#shoot-file'),
  previewHidden: (document.querySelector('#shoot-local-preview')||{}).hidden ?? true,
  subjectCards: document.querySelectorAll('.subject-card').length,
  subjects: [...document.querySelectorAll('.subject-card span:first-child')].map(s => s.textContent.trim()),
}))()`);
await evalJs(`document.querySelector('[data-subject="PERSON"]').click()`);
await waitFor(`!!document.querySelector('#shoot-mood-chips [data-mood]')`, 8000);
const moodCount = await evalJs(`document.querySelectorAll('#shoot-mood-chips [data-mood]').length`);
await evalJs(`(() => { const b = document.querySelector('#shoot-mood-chips [data-mood]'); if (b) b.click(); return !!b; })()`);
await waitFor(`!!document.querySelector('#shoot-works-grid .art-tile')`, 8000);
const workCount = await evalJs(`document.querySelectorAll('#shoot-works-grid .art-tile').length`);
await evalJs(`(() => { const t = document.querySelector('#shoot-works-grid .art-tile'); if (t) t.click(); return !!t; })()`);
await waitFor(`!!document.querySelector('.shoot-detail') || !!document.querySelector('[data-overlay-toggle]')`, 12000);
await sleep(900);
const shootGuide = await evalJs(`(() => ({
  badge: (document.querySelector('.subject-badge')||{}).textContent || '',
  guideRows: document.querySelectorAll('.camera-guide div').length,
  overlayToggle: !!document.querySelector('[data-overlay-toggle]'),
  plainLanguage: /人站哪里|人物占画面比例|地平线放在哪里|主体放在哪里|推荐距离|推荐时间/.test(document.body.innerText),
}))()`);
out.shoot = { shootRefs, moodCount, workCount, shootGuide };

// ---------- 6) Local image instant preview (FIND image mode) ----------
await evalJs(`window.location.hash = '#find'`);
await waitFor(`!!document.querySelector('#find-run')`, 12000);
await sleep(500);
await evalJs(`(() => { const m = document.querySelector('[data-find-mode="image"]'); if (m) m.click(); return !!m; })()`);
await sleep(400);
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
const localImage = await evalJs(`(() => ({
  previewVisible: (() => { const p = document.querySelector('#find-preview'); return !!p && !p.hidden && p.src.startsWith('blob:'); })(),
  runButtonVisible: (() => { const b = document.querySelector('#find-image-run'); return !!b && !b.hidden; })(),
}))()`);
out.localImage = localImage;

// ---------- Search overlay (⌕) ----------
await evalJs(`document.querySelector('#top-search-trigger').click()`);
await waitFor(`!document.querySelector('#search-layer').hidden`, 8000);
await evalJs(`(() => { const i = document.querySelector('#global-search'); i.value='孤独'; i.dispatchEvent(new Event('input',{bubbles:true})); return 1; })()`);
await sleep(600);
const searchOverlay = await evalJs(`(() => ({
  open: !document.querySelector('#search-layer').hidden,
  status: (document.querySelector('#search-layer-status')||{}).textContent || '',
  results: document.querySelectorAll('#search-layer-results .sresult').length,
}))()`);
out.searchOverlay = searchOverlay;

out.consoleErrors = errors;
writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log("FRAME-ATLAS-ACC-DONE");
page.ws.close();
edge.kill();
process.exit(0);
