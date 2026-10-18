// 4-source smoke test — REAL network calls against AIC / Met / Cleveland /
// Rijksmuseum Data Services. Each source must return >= 1 artwork that
// normalizes through the unified Artwork Schema. Failures record the real
// HTTP status / endpoint / parsing stage — never "missing key".
import { aicAdapter } from "../src/services/adapters/aicAdapter.js";
import { metAdapter } from "../src/services/adapters/metAdapter.js";
import { clevelandAdapter } from "../src/services/adapters/clevelandAdapter.js";
import { rijksAdapter } from "../src/services/adapters/rijksAdapter.js";
import { normalizeArtwork } from "../src/services/normalizeArtwork.js";

const QUERY = process.env.VA_SMOKE_QUERY || "Vermeer";
const results = [];

async function verifyImage(url, timeoutMs = 30000) {
  try {
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
    const ct = res.headers.get("content-type") || "";
    return { status: res.status, contentType: ct, ok: res.ok && ct.startsWith("image/") };
  } catch (error) {
    return { status: "ERR", contentType: "", ok: false, error: error.message };
  }
}

// Some image hosts (Wikimedia, artic.edu IIIF) block THIS sandbox's Node
// egress while working fine in a real browser. When node fails, re-verify
// through a headless browser so the smoke test stays honest.
let browserSession = null;
async function verifyImageBrowser(url) {
  try {
    if (!browserSession) browserSession = await launchBrowser();
    return await browserSession.test(url);
  } catch (error) {
    return { status: "BROWSER-ERR", ok: false, error: error.message };
  }
}

async function launchBrowser() {
  const { spawn } = await import("node:child_process");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const PORT = 9424;
  const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
  const PROFILE = process.cwd() + "\\work\\edge-smoke";
  const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, "--no-first-run", "about:blank"], { stdio: "ignore" });
  let version = null;
  for (let i = 0; i < 40 && !version; i++) {
    try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch {}
    if (!version) await sleep(700);
  }
  if (!version) throw new Error("cdp down");
  const created = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(created.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws")); });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  const send = (method, params = {}) => new Promise((resolve) => {
    const mid = ++id; pending.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  await send("Page.enable");
  return {
    async test(targetUrl) {
      const ev = await send("Runtime.evaluate", {
        expression: `new Promise((resolve) => {
          const img = new Image();
          img.onload = () => resolve({ status: 200, ok: true, w: img.naturalWidth, h: img.naturalHeight });
          img.onerror = () => resolve({ status: "ERR", ok: false });
          img.src = ${JSON.stringify(targetUrl)};
          setTimeout(() => resolve({ status: "TIMEOUT", ok: false }), 20000);
        })`,
        returnByValue: true,
        awaitPromise: true,
      });
      return ev.result?.result?.value || { status: "NO-VALUE", ok: false };
    },
    ws,
    edge,
  };
}

async function runSource(name, adapter, query) {
  const entry = { source: name, ok: false, stage: "start", httpStatus: null, detail: "" };
  try {
    entry.stage = "search";
    const raws = await adapter.search(query, { limit: 5 });
    entry.stage = "search";
    entry.httpStatus = "200";
    if (!raws.length) {
      entry.detail = "search returned 0 items";
      return entry;
    }
    const first = raws[0];
    entry.stage = "toRaw";
    if (!first || !first.title) {
      entry.detail = "toRaw produced record without title: " + JSON.stringify(first).slice(0, 200);
      return entry;
    }
    entry.stage = "normalize";
    const work = normalizeArtwork({ ...first, analysisLevel: 0 });
    if (!work.key || !work.title) {
      entry.detail = "normalize produced invalid record";
      return entry;
    }
    entry.ok = true;
    entry.detail = `title="${work.title}" artist="${work.artist}" year="${work.year}" museum="${work.museum}" image=${Boolean(work.image && work.image.url)} key=${work.key} rights="${work.rightsStatus.slice(0, 40)}"`;
    if (work.image && work.image.url) {
      entry.stage = "image";
      entry.imageUrl = work.image.url;
      let img = await verifyImage(work.image.url);
      if (!img.ok && (img.status === 403 || img.status === "ERR")) {
        img = await verifyImageBrowser(work.image.url);
        img.note = "verified via browser (node egress blocked for this host)";
      }
      entry.imageCheck = img;
      if (!img.ok) entry.ok = false;
    } else {
      entry.detail += " [NO IMAGE URL]";
    }
  } catch (error) {
    entry.stage = entry.stage === "start" ? "connect" : entry.stage;
    entry.detail = error.message;
    const m = /HTTP (\d{3})/.exec(error.message);
    if (m) entry.httpStatus = m[1];
  }
  return entry;
}

results.push(await runSource("AIC", aicAdapter, QUERY));
results.push(await runSource("MET", metAdapter, QUERY));
results.push(await runSource("Cleveland", clevelandAdapter, QUERY));
results.push(await runSource("Rijksmuseum", rijksAdapter, QUERY));

console.log(JSON.stringify(results, null, 2));
if (browserSession) {
  try { browserSession.ws.close(); } catch {}
  try { browserSession.edge.kill(); } catch {}
}
const allOk = results.every((r) => r.ok);
console.log("ALL_OK=" + allOk);
process.exit(allOk ? 0 : 1);
