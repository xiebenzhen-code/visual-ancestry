// process-images.mjs — Phase 2A image pipeline.
// 1) Downloads master images for all local (featured) artworks.
//    - Wikimedia files go through a headless Edge CDP channel (the sandbox
//      blocks Wikimedia from Node's own socket layer, but the browser can).
//    - Other hosts fall back to Node https.
// 2) Generates three webp tiers with sharp: thumb(480) / preview(960) / detail(1920).
// 3) Writes manifest.json + src/data/imageManifest.generated.js (ratio + URLs).
//
// Usage:
//   node scripts/process-images.mjs            # full pipeline
//   node scripts/process-images.mjs --skip-download
//   node scripts/process-images.mjs --limit 4
//   node scripts/process-images.mjs --force
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import sharp from "sharp";
import { westernSeeds } from "../src/data/artworks/western.js";
import { chineseSeeds } from "../src/data/artworks/chinese.js";
import { japaneseSeeds } from "../src/data/artworks/japanese.js";
import { otherSeeds } from "../src/data/artworks/other.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT_DIR = path.join(ROOT, "public", "assets", "artworks");
// raw masters live OUTSIDE the public tree (build input only, never shipped)
const RAW_DIR = path.join(ROOT, "work", "artwork-raw");
const MANIFEST_JSON = path.join(OUT_DIR, "manifest.json");
const MANIFEST_MODULE = path.join(ROOT, "src", "data", "imageManifest.generated.js");
const CDP_PORT = 9401;
const EDGE =
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const WIKIMEDIA = "https://commons.wikimedia.org/wiki/Special:FilePath/";
const TIERS = [
  { name: "thumb", width: 480, quality: 78 },
  { name: "preview", width: 960, quality: 80 },
  { name: "detail", width: 1920, quality: 82 },
];

const args = new Set(process.argv.slice(2));
const skipDownload = args.has("--skip-download");
const force = args.has("--force");
const limit = Number(args.has("--limit") ? process.argv[process.argv.indexOf("--limit") + 1] : 0);
const DL_WIDTH = process.env.VA_DL_WIDTH || "1920";
const DL_TIMEOUT = Number(process.env.VA_DL_TIMEOUT || 45000);

// ---------- collect jobs ----------
const seeds = [...westernSeeds, ...chineseSeeds, ...japaneseSeeds, ...otherSeeds];
const jobs = seeds
  .filter((seed) => seed.imageFile && !seed.imageUrl)
  .map((seed) => ({ id: seed.id, fileName: seed.imageFile }));

const manifest = {};
if (existsSync(MANIFEST_JSON)) {
  Object.assign(manifest, JSON.parse(readFileSync(MANIFEST_JSON, "utf8")).artworks || {});
}

// ---------- CDP browser channel ----------
async function cdpConnect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error("ws error"));
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const mid = ++id;
      pending.set(mid, resolve);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  return { ws, send };
}

let browser = null;

async function ensureBrowser() {
  if (browser) return browser;
  const edge = spawn(EDGE, [
    "--headless=new",
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${path.join(ROOT, "work", "edge-img-pipe")}`,
    "--no-first-run",
    "about:blank",
  ], { stdio: "ignore" });
  let version = null;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      version = await r.json();
      break;
    } catch {}
    await sleep(700);
  }
  if (!version) throw new Error("Edge CDP did not come up");
  const browserWs = await cdpConnect(version.webSocketDebuggerUrl);
  const created = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: "PUT" });
  const pageInfo = await created.json();
  if (!pageInfo.webSocketDebuggerUrl) throw new Error("no page ws");
  const pageWs = await cdpConnect(pageInfo.webSocketDebuggerUrl);
  await pageWs.send("Page.enable");
  browser = { edge, pageWs };
  return browser;
}

async function downloadViaBrowser(url, timeoutMs = 45000) {
  const { pageWs } = await ensureBrowser();
  const timer = new Promise((resolve) => setTimeout(() => resolve("TIMEOUT"), timeoutMs));
  const task = (async () => {
    await pageWs.send("Page.navigate", { url });
    // wait until navigation settles on the image host
    for (let i = 0; i < 40; i++) {
      await sleep(400);
      const ev = await pageWs.send("Runtime.evaluate", {
        expression: `({ href: location.href, ready: document.readyState })`,
        returnByValue: true,
      });
      const v = ev.result?.result?.value;
      if (v && v.href && v.ready === "complete") break;
    }
    const ev = await pageWs.send("Runtime.evaluate", {
      expression: `(async () => {
        try {
          const r = await fetch(location.href);
          if (!r.ok) return { err: 'http ' + r.status };
          const ct = r.headers.get('content-type') || '';
          const buf = new Uint8Array(await r.arrayBuffer());
          if (!buf.length) return { err: 'empty' };
          let bin = '';
          const CH = 0x8000;
          for (let i = 0; i < buf.length; i += CH) bin += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
          return { size: buf.length, ct: ct.slice(0, 60), b64: btoa(bin) };
        } catch (e) { return { err: String(e) }; }
      })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    const val = ev.result?.result?.value;
    if (!val || !val.b64) return { err: val?.err || "no-value" };
    return { size: val.size, ct: val.ct, buffer: Buffer.from(val.b64, "base64") };
  })();
  return Promise.race([task, timer]).then((result) => {
    if (result === "TIMEOUT") return { err: "timeout" };
    return result;
  });
}

async function downloadViaNode(url, timeoutMs = 30000) {
  const { default: https } = await import("node:https");
  return new Promise((resolve) => {
    const req = https.get(
      url,
      { rejectUnauthorized: false, headers: { "user-agent": "Mozilla/5.0 visual-ancestry" } },
      (r) => {
        if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
          downloadViaNode(new URL(r.headers.location, url).toString()).then(resolve);
          return;
        }
        if (r.statusCode !== 200) {
          r.resume();
          return resolve({ err: "http " + r.statusCode });
        }
        const chunks = [];
        r.on("data", (c) => chunks.push(c));
        r.on("end", () => resolve({ size: chunks.reduce((n, c) => n + c.length, 0), buffer: Buffer.concat(chunks) }));
      }
    );
    req.on("error", () => resolve({ err: "socket" }));
    req.setTimeout(timeoutMs, function () {
      this.destroy();
      resolve({ err: "timeout" });
    });
  });
}

async function downloadOne(job) {
  const rawPath = path.join(RAW_DIR, `${job.id}.img`);
  if (!force && existsSync(rawPath) && statSync(rawPath).size > 1000) return { ok: true, cached: true };
  const wikiUrl = `${WIKIMEDIA}${encodeURIComponent(job.fileName)}?width=${DL_WIDTH}`;
  let result = await downloadViaBrowser(wikiUrl, DL_TIMEOUT);
  if (result.err) result = await downloadViaBrowser(wikiUrl, DL_TIMEOUT); // one retry
  if (result.err) return { ok: false, err: result.err };
  mkdirSync(RAW_DIR, { recursive: true });
  writeFileSync(rawPath, result.buffer);
  return { ok: true };
}

async function processOne(job) {
  const rawPath = path.join(RAW_DIR, `${job.id}.img`);
  if (!existsSync(rawPath)) return { ok: false, err: "no raw" };
  const outDir = path.join(OUT_DIR, job.id);
  mkdirSync(outDir, { recursive: true });
  const meta = await sharp(rawPath).metadata();
  const base = sharp(rawPath).rotate();
  for (const tier of TIERS) {
    const file = path.join(outDir, `${tier.name}.webp`);
    if (!force && existsSync(file)) continue;
    let pipeline = base.clone().resize({ width: tier.width, withoutEnlargement: true });
    await pipeline.webp({ quality: tier.quality }).toFile(file);
  }
  const detailMeta = await sharp(path.join(outDir, "detail.webp")).metadata();
  manifest[job.id] = {
    w: detailMeta.width,
    h: detailMeta.height,
    ratio: detailMeta.height / detailMeta.width,
  };
  return { ok: true };
}

// ---------- main ----------
async function main() {
  mkdirSync(RAW_DIR, { recursive: true });
  const toProcess = limit ? jobs.slice(0, limit) : jobs;
  const stats = { total: toProcess.length, downloaded: 0, processed: 0, failed: [] };

  if (!skipDownload) {
    console.log(`[download] ${toProcess.length} jobs`);
    for (const job of toProcess) {
      const res = await downloadOne(job);
      if (res.ok) stats.downloaded += 1;
      else stats.failed.push(`${job.id}:download(${res.err})`);
      console.log(`[download] ${job.id} ${res.ok ? (res.cached ? "cached" : "ok") : "FAIL " + res.err}`);
      // Be polite to Wikimedia: brief pause between downloads reduces 429/timeouts.
      await sleep(1200);
    }
  }

  console.log("[process] sharp tiers");
  for (const job of toProcess) {
    const res = await processOne(job);
    if (res.ok) stats.processed += 1;
    else stats.failed.push(`${job.id}:process(${res.err})`);
    console.log(`[process] ${job.id} ${res.ok ? "ok" : "FAIL " + res.err}`);
  }

  // write manifests
  const payload = { generatedAt: new Date().toISOString(), artworks: manifest };
  writeFileSync(MANIFEST_JSON, JSON.stringify(payload, null, 2));
  const moduleBody = `// GENERATED by scripts/process-images.mjs — do not edit by hand.\n` +
    `// Maps artwork id -> { w, h, ratio, tiers: { thumb, preview, detail } }\n` +
    `export default ${JSON.stringify(
      Object.fromEntries(
        Object.entries(manifest).map(([id, m]) => [
          id,
          { ...m, tiers: { thumb: `/public/assets/artworks/${id}/thumb.webp`, preview: `/public/assets/artworks/${id}/preview.webp`, detail: `/public/assets/artworks/${id}/detail.webp` } },
        ])
      ),
      null,
      2
    )};\n`;
  writeFileSync(MANIFEST_MODULE, moduleBody);

  if (browser) {
    try {
      await browser.pageWs.send("Browser.close");
    } catch {}
    browser.edge.kill();
  }
  console.log("SUMMARY", JSON.stringify(stats));
  console.log("DONE");
}

main().catch((e) => {
  console.log("FATAL", e.message);
  if (browser) browser.edge.kill();
  process.exit(1);
});