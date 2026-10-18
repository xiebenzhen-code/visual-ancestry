// Vision Calibration Harness — V5.1 P2.3.
//
// Minimal, list-based calibration for the REAL vision chain (no UI, no mock):
//   curated local image (fixed list from public/assets/artworks/manifest.json)
//   → fetch webp blob → File → prepareVisionImage (client resize)
//   → base64 → POST /api/vision (same-origin bridge on the RUNNING server)
//   → server/vision/openaiProvider.mjs → REAL provider → structured VisualIntent
//   → normalizeVisionIntent (browser whitelist)
//
// Rules:
//   - NEVER bypasses /api/vision; the bridge is the only entry.
//   - NEVER mocks the provider.
//   - Model string is passed in via --model (bridge response does not expose
//     the model; the authoritative value lives in the server-process env,
//     which we do NOT read).
//   - Cost discipline: default run is ONE image (first of the fixed list =
//     wanderer/detail.webp). --limit=N or explicit ids widen the run.
//   - No sequential re-calls: each image gets exactly 1 POST (≤1 transient
//     provider retry, inside the server as contracted).
//
// Usage:
//   node qa/vision-calibration.mjs                     # 1 image (wanderer)
//   node qa/vision-calibration.mjs --limit=3           # first 3 of fixed list
//   node qa/vision-calibration.mjs starry the-kiss     # exact ids
//   node qa/vision-calibration.mjs --model=gpt-5.6-sol
//
// Writes qa/vision-calibration-results.json
//   And (via the caller) feeds qa/vision-calibration-report.md
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

const BASE = "http://127.0.0.1:4175"; // the running server that holds the real env
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const CDP_PORT = 9493; // distinct debug port per harness
const PROFILE = "C:<local-path>";
const ROOT = "C:<local-path>";
const MANIFEST_PATH = `${ROOT}/public/assets/artworks/manifest.json`;
const OUT = `${ROOT}/qa/vision-calibration-results.json`;

// ---- CLI ------------------------------------------------------------------//
const args = process.argv.slice(2);
const argModel = args.find((a) => a.startsWith("--model="))?.slice("--model=".length);
const argLimit = args.find((a) => a.startsWith("--limit="))?.slice("--limit=".length);
const explicitIds = args.filter((a) => !a.startsWith("--"));
const MODEL = argModel || "unobserved"; // bridge does not expose it; user confirms server env
const LIMIT = argLimit ? Number(argLimit) : null;

// ---- Fixed curated list (source of truth: manifest) ------------------------//
const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
const FIXED_IDS = Object.keys(manifest.artworks || {}); // manifest order; wanderer first

let targets;
if (explicitIds.length) {
  targets = explicitIds;
} else if (LIMIT !== null) {
  targets = FIXED_IDS.slice(0, LIMIT);
} else {
  targets = FIXED_IDS.slice(0, 1); // default: exactly ONE image, no extra spend
}
console.log(`CALIBRATION targets (${targets.length}): ${targets.join(", ")}`);
console.log(`CALIBRATION model: ${MODEL}`);

// ---- Append mode: reuse previously recorded images (cost discipline) -------//
// Existing records in qa/vision-calibration-results.json are preserved; images
// already recorded are skipped (no double spend). Explicit ids always re-run.
let existingRecords = [];
try {
  const prev = JSON.parse(await readFile(OUT, "utf8"));
  if (prev && Array.isArray(prev.results)) existingRecords = prev.results;
} catch {}
const recordedImages = new Set(existingRecords.map((r) => String(r.image)));
let skippedCount = 0;
if (!explicitIds.length) {
  const before = targets.length;
  targets = targets.filter((id) => !recordedImages.has(id + "/detail.webp"));
  skippedCount = before - targets.length;
  if (skippedCount > 0) console.log(`CALIBRATION append: skipping ${skippedCount} already recorded (${recordedImages.size} existing record(s) kept)`);
}
if (!targets.length) {
  console.log("CALIBRATION nothing new to run (all targets already recorded)");
  process.exit(0);
}

// ---- CDP plumbing (same pattern as real-preflight.mjs) --------------------//
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

const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`, "--no-first-run", "about:blank"], { stdio: "ignore" });
let version = null;
for (let i = 0; i < 40 && !version; i++) {
  try { version = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json(); } catch {}
  if (!version) await sleep(700);
}
if (!version) {
  console.log("CALIBRATION FATAL: edge CDP not reachable");
  process.exit(1);
}
const consoleErrors = [];
const created = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: "PUT" })).json();
const page = await cdpConnect(created.webSocketDebuggerUrl, (msg) => {
  if (msg.method === "Runtime.exceptionThrown") consoleErrors.push("EXC: " + (msg.params?.exceptionDetails?.text || "?"));
  if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
    consoleErrors.push("CONSOLE_ERROR: " + (msg.params.args || []).map((a) => a.value || a.description || "").join(" ").slice(0, 160));
  }
});
const call = page.send;
const evalJs = async (expr) => {
  const r = await call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.text || "" };
  return r.result?.result?.value;
};
const waitFor = async (expr, timeoutMs = 20000) => {
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
await call("Page.navigate", { url: `${BASE}/?v=calib#index` });
await waitFor(`!!document.querySelector('.edition-plates .plate')`, 20000);
await sleep(500);

// ---- Per-image runner (full REAL chain, executed in page context) -----------//
const RUNNER = (imageId) => `
(async () => {
  const out = { ok: null, step: "" };
  try {
    out.step = "load-curated";
    const url = ${JSON.stringify(BASE)} + "/public/assets/artworks/" + ${JSON.stringify(imageId)} + "/detail.webp";
    const blob = await (await fetch(url)).blob();
    const file = new File([blob], ${JSON.stringify(imageId + ".webp")}, { type: "image/webp" });

    out.step = "prepare-resize";
    const { prepareVisionImage } = await import(${JSON.stringify(BASE)} + "/src/services/vision/prepareVisionImage.js");
    const prepared = await prepareVisionImage(file);
    const resized = prepared.file;

    out.step = "base64";
    const buf = new Uint8Array(await resized.arrayBuffer());
    let bin = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < buf.length; i += CHUNK) bin += String.fromCharCode(...buf.subarray(i, i + CHUNK));
    const imageBase64 = btoa(bin);
    out.input = {
      srcW: prepared.srcW, srcH: prepared.srcH,
      sentW: resized.width ?? prepared.width, sentH: resized.height ?? prepared.height,
      compressedBytes: resized.size, mimeType: resized.type,
    };

    out.step = "post-bridge";
    const res = await fetch(${JSON.stringify(BASE)} + "/api/vision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageBase64, mimeType: resized.type }),
    });
    out.httpStatus = res.status;
    let data;
    try { data = await res.json(); } catch { data = null; }
    out.rawResponse = data;
    out.bridgeLatencyMs = (data && typeof data.latencyMs === "number") ? data.latencyMs : null;

    if (res.status !== 200 || !data || !data.ok || !data.intent || typeof data.intent !== "object") {
      out.ok = false;
      out.error = (data && data.error) ? { code: data.error.code, message: data.error.message } : { code: "non-200", message: "HTTP " + res.status };
      return out;
    }

    out.step = "normalize";
    const { normalizeVisionIntent } = await import(${JSON.stringify(BASE)} + "/src/services/vision/normalizeVisionIntent.js");
    const intent = normalizeVisionIntent(data.intent);
    out.schemaValid = !!intent;
    out.visualIntent = intent;
    out.rawIntent = data.intent;
    out.ok = true;
    return out;
  } catch (e) {
    out.ok = false;
    out.error = { code: "page-error", message: String((e && e.stack) || e) };
    return out;
  }
})()
`;

// ---- Run + record ----------------------------------------------------------//
const results = [];
for (const imageId of targets) {
  const record = {
    image: `${imageId}/detail.webp`,
    model: MODEL,
    timestamp: new Date().toISOString(),
    latencyMs: null,
    httpStatus: null,
    schemaValid: null,
    unknownEnums: null,
    visualIntent: null,
    errors: [],
  };

  const r = await evalJs(RUNNER(imageId));

  if (r && r.__err) {
    record.errors.push("page-eval-error: " + r.__err);
  } else if (!r) {
    record.errors.push("no result from page");
  } else {
    record.httpStatus = r.httpStatus ?? null;
    record.latencyMs = r.bridgeLatencyMs;
    if (r.input) record.input = r.input;
    if (r.ok) {
      record.schemaValid = r.schemaValid === true;
      record.visualIntent = r.visualIntent || null;

      // unknownEnums: raw tokens that the whitelist dropped
      const raw = r.rawIntent || {};
      const norm = r.visualIntent || {};
      let unknownEnums = 0;
      const detail = [];
      for (const [k, v] of Object.entries(raw)) {
        if (k === "source") continue;
        if (Array.isArray(v)) {
          const kept = Array.isArray(norm[k]) ? norm[k] : [];
          const dropped = v.filter((t) => !kept.includes(t));
          if (dropped.length) { unknownEnums += dropped.length; detail.push(k + ":" + dropped.join(",")); }
        } else if (v !== null && v !== "" && norm[k] !== v) {
          unknownEnums += 1;
          detail.push(k + ":" + String(v) + "->" + (norm[k] === undefined ? "dropped" : norm[k]));
        }
      }
      record.unknownEnums = unknownEnums;
      if (detail.length) record.unknownEnumsDetail = detail;

      // empty-response check: no usable visual fields at all
      const usable = norm && Object.keys(norm).filter((k) => k !== "source" && norm[k] !== null && norm[k] !== "" && !(Array.isArray(norm[k]) && norm[k].length === 0)).length;
      if (!usable || usable === 0) record.errors.push("empty-intent: no usable visual fields");

      if (!record.schemaValid) record.errors.push("schema-invalid: normalize returned null");
    } else if (r.error) {
      record.errors.push(`${r.error.code}: ${r.error.message}`);
    }
    if (record.httpStatus !== 200) record.errors.push("httpStatus != 200");
    if (record.latencyMs === null) record.errors.push("latency not recorded");
    if (r.input) {
      if (r.input.compressedBytes >= 6 * 1024 * 1024) record.errors.push("payload near/over 6MB cap");
    }
  }

  record.consoleErrors = consoleErrors.slice();
  results.push(record);
  console.log(`CALIBRATION ${record.image} → HTTP ${record.httpStatus} unknownEnums=${record.unknownEnums} errors=${record.errors.length}`);

  // Cost discipline: a default (no args) run is ONE image. Wider runs only
  // happen when the caller explicitly asks via --limit=N or explicit ids.
  if (!explicitIds.length && LIMIT === null) break;
}

// ---- Persist ----------------------------------------------------------------//
// Append mode: previous records are preserved, new records appended. The file
// therefore accumulates calibration runs (1 → 10 → …) without double spend.
const merged = [...existingRecords, ...results];
const payload = {
  generatedAt: new Date().toISOString(),
  base: BASE,
  model: MODEL,
  imagesTested: merged.length,
  results: merged,
};
await writeFile(OUT, JSON.stringify(payload, null, 2));
const okNew = results.filter((x) => x.httpStatus === 200 && x.schemaValid === true && x.unknownEnums === 0 && x.errors.length === 0).length;
const okAll = merged.filter((x) => x.httpStatus === 200 && x.schemaValid === true && x.unknownEnums === 0 && x.errors.length === 0).length;
console.log(`CALIBRATION-DONE new=${okNew}/${results.length} total=${okAll}/${merged.length} ${okNew === results.length ? "ok" : "issues"}`);
page.ws.close();
edge.kill();
process.exit(0);