// REAL Vision Preflight — V5.1 P2.2.
//
// Exactly ONE real vision request, full browser chain, no mock:
//   curated local image
//   → fetch webp blob (local asset) → File
//   → prepareVisionImage (client resize/compress)
//   → fileToBase64
//   → POST /api/vision            (same-origin bridge on the RUNNING server)
//   → server/vision/openaiProvider.mjs → REAL provider
//   → structured VisualIntent
//   → normalizeVisionIntent
//
// The API key is NEVER read, printed, copied or modified. The target server is
// the one currently holding the real env (port 4175, PID 11328 in the last
// check) — we only talk to it over HTTP.
//
// PASS requires: HTTP 200, requestCount === 1, schemaValid, normalize ok,
// unknownEnums === 0, secretLeak === 0.
// On failure we stop immediately, keep the real error response, classify it,
// and never retry / never switch model / never switch endpoint.
//
// Writes qa/real-preflight.json
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 9492;
const BASE = "http://127.0.0.1:4175"; // the running server that holds the real env
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PROFILE = "C:<local-path>";
const OUT = "C:<local-path>";
const ART_URL = "http://127.0.0.1:4175/public/assets/artworks/wanderer/detail.webp";

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
const consoleErrors = [];
const created = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
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

// Landing page gives us module scope + same-origin asset access.
await call("Page.navigate", { url: `${BASE}/?v=realpre#index` });
await waitFor(`!!document.querySelector('.edition-plates .plate')`, 20000);
await sleep(600);

// ONE real request, full chain, executed in page context.
const RUNNER = `
(async () => {
  const out = { ok: null, step: "" };
  try {
    out.step = "load-curated";
    const blob = await (await fetch(${JSON.stringify(ART_URL)})).blob();
    const file = new File([blob], "wanderer.webp", { type: "image/webp" });

    out.step = "prepare-resize";
    const { prepareVisionImage } = await import("${BASE}/src/services/vision/prepareVisionImage.js");
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
    const t0 = performance.now();
    const res = await fetch("${BASE}/api/vision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageBase64, mimeType: resized.type }),
    });
    out.httpStatus = res.status;
    out.clientLatencyMs = Math.round(performance.now() - t0);
    const data = await res.json();
    out.bridgeLatencyMs = typeof data.latencyMs === "number" ? data.latencyMs : null;
    out.rawResponse = data;

    if (res.status !== 200) {
      out.ok = false;
      out.error = data && data.error ? { code: data.error.code, message: data.error.message } : { code: "non-200", message: "HTTP " + res.status };
      return out;
    }
    if (!data.ok || !data.intent || typeof data.intent !== "object") {
      out.ok = false;
      out.error = { code: "schema", message: "success response lacks intent object" };
      return out;
    }

    out.step = "normalize";
    const { normalizeVisionIntent } = await import("${BASE}/src/services/vision/normalizeVisionIntent.js");
    const intent = normalizeVisionIntent(data.intent);
    out.schemaValid = !!intent;
    out.normalizedIntent = intent;
    out.ok = true;
    return out;
  } catch (e) {
    out.ok = false;
    out.error = { code: "page-error", message: String((e && e.stack) || e) };
    return out;
  }
})()
`;

const result = await evalJs(RUNNER);

// unknownEnums: raw fields that carry a legal-looking value but were dropped
// by the whitelist (i.e. token not in normalizeVisionIntent's enums).
if (result && result.ok) {
  const raw = result.rawResponse.intent || {};
  const norm = result.normalizedIntent || {};
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
  result.unknownEnums = unknownEnums;
  result.unknownEnumsDetail = detail;
  // secretLeak over the full response text + request-relevant strings
  const text = JSON.stringify({ raw: result.rawResponse, norm: result.normalizedIntent });
  const leakMatches = text.match(/(api[_-]?key|secret|authorization|bearer|token|password)/gi) || [];
  result.secretLeak = leakMatches.length;
  result.realRequestCount = 1;
}

result.consoleErrors = consoleErrors;
result.curlTime = new Date().toISOString();
await writeFile(OUT, JSON.stringify(result, null, 2));
console.log("REAL-PREFLIGHT-DONE " + (result && result.ok ? "ok" : "failed"));
page.ws.close();
edge.kill();
process.exit(0);