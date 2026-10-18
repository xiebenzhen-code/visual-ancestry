// qa2a5-acceptance.mjs — Phase 2A.5 acceptance: the four user tasks, run
// and RECORDED on desktop and mobile. Outputs:
//   qa/qa2a5-results.json        — assertion summary
//   qa/video-desktop/frames/*.jpg -> qa2a5-desktop.mp4
//   qa/video-mobile/frames/*.jpg  -> qa2a5-mobile.mp4
// Frames come from CDP Page.startScreencast; ffmpeg encodes them to mp4.
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 9430;
const BASE = "http://127.0.0.1:4175";
const ROOT = "C:<local-path>";
const OUT = ROOT + "/qa";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const FFMPEG = "C:\\Users\\25186\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-9.0.1-full_build\\bin\\ffmpeg.exe";
const PROFILE = ROOT + "\\work\\edge-qa2a5";

const results = { desktop: {}, mobile: {} };
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

async function boot(viewport, cdpPort, profile) {
  const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, "--no-first-run", "about:blank"], { stdio: "ignore" });
  let version = null;
  for (let i = 0; i < 40 && !version; i++) {
    try { version = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json(); } catch {}
    if (!version) await sleep(700);
  }
  if (!version) throw new Error("cdp down on " + cdpPort);
  const browserWs = await cdpConnect(version.webSocketDebuggerUrl);
  const created = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
  const frames = [];
  const page = await cdpConnect(created.webSocketDebuggerUrl, (msg) => {
    if (msg.method === "Runtime.exceptionThrown") errors.push("EXC: " + (msg.params?.exceptionDetails?.text || "?"));
    if (msg.method === "Page.screencastFrame") {
      frames.push({ data: msg.params.data, id: msg.params.sessionId });
      page.send("Page.screencastFrameAck", { sessionId: msg.params.sessionId }).catch(() => {});
    }
  });
  const call = page.send;
  await call("Runtime.enable");
  await call("Page.enable");
  await call("Emulation.setDeviceMetricsOverride", { width: viewport.w, height: viewport.h, deviceScaleFactor: 1, mobile: viewport.mobile });
  return { edge, browserWs, page, call, frames };
}

const evalJs = async (call, expr) => {
  const r = await call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { __err: (r.result.exceptionDetails.text || "") };
  return r.result?.result?.value;
};

// Poll until a DOM condition is true (cold module-loading can take >3s).
async function waitFor(call, expr, timeoutMs = 15000) {
  const start = Date.now();
  for (;;) {
    const v = await evalJs(call, expr);
    if (v) return v;
    if (Date.now() - start > timeoutMs) return null;
    await sleep(400);
  }
}

// Navigate to a hash and wait until the app has mounted that route.
async function goto(call, hash, marker) {
  await call("Page.navigate", { url: `${BASE}/#${hash}` });
  const ok = await waitFor(call, `!!document.querySelector('${marker}')`, 15000);
  await sleep(800);
  return ok;
}

async function recordSession({ name, viewport, script, resultsKey, cdpPort }) {
  const { edge, browserWs, page, call, frames } = await boot(viewport, cdpPort, `${PROFILE}-${name}`);
  const dir = `${OUT}/video-${name}/frames`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  await goto(call, "index", ".hero");
  await call("Page.startScreencast", { format: "jpeg", quality: 72, everyNthFrame: 2, maxWidth: viewport.w, maxHeight: viewport.h });
  await sleep(600);

  for (const item of script) {
    try {
      const value = await item.step({ call, evalJs, sleep, OUT, goto });
      if (item.name) results[resultsKey][item.name] = value;
    } catch (e) {
      results[resultsKey][item.name || "step"] = { __err: e.message };
    }
    await sleep(400);
  }

  await sleep(600);
  await call("Page.stopScreencast").catch(() => {});
  await sleep(300);

  // save frames
  frames.forEach((f, i) => {
    writeFileSync(`${dir}/frame-${String(i).padStart(4, "0")}.jpg`, Buffer.from(f.data, "base64"));
  });
  results[resultsKey]._frames = frames.length;
  console.log(`[${name}] frames=${frames.length}`);

  // encode with ffmpeg
  const { execFileSync } = await import("node:child_process");
  try {
    execFileSync(FFMPEG, [
      "-y", "-framerate", "10", "-i", `${dir}/frame-%04d.jpg`,
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
      `${OUT}/qa2a5-${name}.mp4`,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    results[resultsKey]._video = `qa2a5-${name}.mp4`;
  } catch (e) {
    results[resultsKey]._videoErr = String(e.message || e).slice(0, 200);
  }

  browserWs.ws.close(); page.ws.close(); edge.kill();
  await sleep(500);
}

// ---------------- desktop flow ----------------
await recordSession({
  name: "desktop",
  viewport: { w: 1440, h: 920, mobile: false },
  resultsKey: "desktop",
  cdpPort: 9431,
  script: [
    {
      name: "home_hero",
      async step({ call, evalJs }) {
        return evalJs(call, `(() => ({
          kicker: (document.querySelector('.hero-kicker')||{}).textContent || '',
          h1: (document.querySelector('.hero h1')||{}).textContent || '',
          entries: [...document.querySelectorAll('.hero-entry')].map(a => a.textContent.replace(/\\s+/g,' ').trim()),
          hasSearch: !!document.querySelector('#hero-search-input'),
          firstTilesInViewport: [...document.querySelectorAll('.feed-tile')].filter(t => t.getBoundingClientRect().top < window.innerHeight).length,
        }))()`);
      },
    },
    {
      name: "search_live_feedback",
      async step({ call, evalJs, sleep }) {
        await evalJs(call, `(() => { const i = document.querySelector('#hero-search-input'); i.value = '水墨'; i.dispatchEvent(new Event('input',{bubbles:true})); return 1; })()`);
        await sleep(250);
        const early = await evalJs(call, `(document.querySelector('#hero-search-status')||{}).textContent || ''`);
        await sleep(2500);
        const late = await evalJs(call, `(() => ({
          status: (document.querySelector('#hero-search-status')||{}).textContent || '',
          results: document.querySelectorAll('#hero-search-results .sresult').length,
        }))()`);
        return { early, ...late };
      },
    },
    {
      name: "search_no_match",
      async step({ call, evalJs, sleep }) {
        await evalJs(call, `(() => { const i = document.querySelector('#hero-search-input'); i.value = 'qqqqzzzz'; i.dispatchEvent(new Event('input',{bubbles:true})); return 1; })()`);
        await sleep(1200);
        return evalJs(call, `(() => ({
          status: (document.querySelector('#hero-search-status')||{}).textContent || '',
          chips: document.querySelectorAll('#hero-search-chips [data-sug]').length,
        }))()`);
      },
    },
    {
      name: "tile_actions_and_detail",
      async step({ call, evalJs, sleep }) {
        await evalJs(call, `(() => { const i = document.querySelector('#hero-search-input'); i.value=''; i.dispatchEvent(new Event('input',{bubbles:true})); return 1; })()`);
        await sleep(600);
        await evalJs(call, `window.scrollTo(0, 500)`);
        await sleep(500);
        // hover the first tile to reveal actions (CSS hover won't fire headless reliably; use click-open)
        await evalJs(call, `document.querySelector('.feed-tile').classList.add('tile-open')`);
        await sleep(400);
        const actions = await evalJs(call, `[...document.querySelectorAll('.feed-tile .tile-actions a')].map(a => a.textContent.trim())`);
        // go to the detail page through the tile body
        await evalJs(call, `window.location.hash = document.querySelector('.feed-tile').getAttribute('href').replace('#','')`);
        await sleep(2600);
        const detail = await evalJs(call, `(() => ({
          h1: (document.querySelector('.detail-head h1')||{}).textContent?.replace(/\\s+/g,' ').trim() || '',
          actions: [...document.querySelectorAll('.detail-actionsrow a')].map(a => a.textContent.trim()),
          facts: !!document.querySelector('.detail-facts'),
          dna: !!document.querySelector('.dna-tags'),
        }))()`);
        return { actions, detail };
      },
    },
    {
      name: "two_steps_to_create",
      async step({ call, evalJs, sleep }) {
        await evalJs(call, `(() => { const a = document.querySelector('[data-detail-action="create"]'); if (a) a.click(); return !!a; })()`);
        await sleep(3000);
        return evalJs(call, `(() => ({
          hash: location.hash,
          steps: [...document.querySelectorAll('.workspace-steps li')].map(li => li.textContent.trim()),
          promptFields: document.querySelectorAll('.prompt-grid .field-block').length,
          combine: !!document.querySelector('#combine-prompt'),
        }))()`);
      },
    },
    {
      name: "two_steps_to_shoot",
      async step({ call, evalJs, sleep }) {
        await evalJs(call, `(() => { const a = document.querySelector('.workspace-back'); if (a) a.click(); return !!a; })()`);
        await sleep(2200);
        // now on create index; go to shoot wizard
        await evalJs(call, `window.location.hash = 'shoot'`);
        await sleep(2600);
        const wiz = await evalJs(call, `(() => ({
          subjectCards: document.querySelectorAll('.subject-card').length,
          subjects: [...document.querySelectorAll('.subject-card span:first-child')].map(s => s.textContent.trim()),
        }))()`);
        await evalJs(call, `document.querySelector('[data-subject="PERSON"]').click()`);
        await sleep(800);
        const moods = await evalJs(call, `document.querySelectorAll('#shoot-mood-chips [data-mood]').length`);
        await evalJs(call, `(() => { const b = document.querySelector('#shoot-mood-chips [data-mood]'); if (b) b.click(); return !!b; })()`);
        await sleep(800);
        const works = await evalJs(call, `document.querySelectorAll('#shoot-works-grid .art-tile').length`);
        await evalJs(call, `(() => { const t = document.querySelector('#shoot-works-grid .art-tile'); if (t) t.click(); return !!t; })()`);
        await sleep(2800);
        const guide = await evalJs(call, `(() => ({
          overlayToggle: !!document.querySelector('[data-overlay-toggle]'),
          guideRows: document.querySelectorAll('.camera-guide div, .guide-row, .shoot-row').length,
          subjectBadge: (document.querySelector('.subject-badge')||{}).textContent || '',
        }))()`);
        return { wiz, moods, works, guide };
      },
    },
  ],
});

// ---------------- mobile flow ----------------
await recordSession({
  name: "mobile",
  viewport: { w: 390, h: 844, mobile: true },
  resultsKey: "mobile",
  cdpPort: 9432,
  script: [
    {
      name: "home_no_overflow",
      async step({ call, evalJs }) {
        return evalJs(call, `(() => ({
          overflow: document.documentElement.scrollWidth > window.innerWidth,
          hero: !!document.querySelector('.hero h1'),
          tiles: document.querySelectorAll('.feed-tile').length,
        }))()`);
      },
    },
    {
      name: "fullscreen_search_layer",
      async step({ call, evalJs, sleep }) {
        await evalJs(call, `document.querySelector('#top-search-trigger').click()`);
        await sleep(600);
        return evalJs(call, `(() => ({
          open: !document.querySelector('#search-layer').hidden,
          focused: document.activeElement && document.activeElement.id === 'global-search',
          panelHeight: document.querySelector('.search-layer-panel').getBoundingClientRect().height,
        }))()`);
      },
    },
    {
      name: "mobile_search_feedback",
      async step({ call, evalJs, sleep }) {
        await evalJs(call, `(() => { const i = document.querySelector('#global-search'); i.value = '夜晚'; i.dispatchEvent(new Event('input',{bubbles:true})); return 1; })()`);
        await sleep(300);
        const early = await evalJs(call, `(document.querySelector('#search-layer-status')||{}).textContent || ''`);
        await sleep(2500);
        const late = await evalJs(call, `(() => ({
          status: (document.querySelector('#search-layer-status')||{}).textContent || '',
          results: document.querySelectorAll('#search-layer-results .sresult').length,
        }))()`);
        return { early, ...late };
      },
    },
    {
      name: "close_layer_detail",
      async step({ call, evalJs, sleep }) {
        await evalJs(call, `(() => { const r = document.querySelector('#search-layer-results .sresult'); if (r) r.click(); return !!r; })()`);
        await sleep(2800);
        const detail = await evalJs(call, `(() => ({
          hash: location.hash,
          h1: (document.querySelector('.detail-head h1')||{}).textContent?.replace(/\\s+/g,' ').trim() || '',
          overflow: document.documentElement.scrollWidth > window.innerWidth,
        }))()`);
        // shoot like this
        await evalJs(call, `(() => { const a = document.querySelector('[data-detail-action="shoot"]'); if (a) a.click(); return !!a; })()`);
        await sleep(2800);
        const guide = await evalJs(call, `(() => ({
          overlayToggle: !!document.querySelector('[data-overlay-toggle]'),
          overflow: document.documentElement.scrollWidth > window.innerWidth,
        }))()`);
        return { detail, guide };
      },
    },
  ],
});

results.consoleErrors = errors;
writeFileSync(`${OUT}/qa2a5-results.json`, JSON.stringify(results, null, 2));
console.log("QA2A5-DONE");
process.exit(0);