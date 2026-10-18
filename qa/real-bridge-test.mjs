// REAL BRIDGE TEST — V5.1 P2.1.
//
// Proves the same-origin bridge chain without a real provider key:
//   Browser POST /api/vision → server.mjs handler → server provider → error
//
// Three assertions:
//   1. No provider configured  → 503 { error: { code: "provider-not-configured" } }
//   2. Bad input (missing field / bad mime) → 400 with machine-readable code
//   3. Provider CALLED but unreachable (fake endpoint) → 502 reason "network"
//      (proves the server really invokes the provider — never a mock intent)
//
// With VA_VISION_BASE/KEY set, the same script performs a REAL call and
// validates { ok, intent } → normalizeVisionIntent → retrieveByIntent.
//
// Writes qa/real-bridge-test.json
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const BASE64_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const FIXTURE = path.join(__dirname, "fixtures", "vision-probe.jpg");

async function startServer(port, env) {
  const child = spawn(process.execPath, [path.join(root, "scripts", "server.mjs"), path.join(root, "dist"), String(port)], {
    env: { ...process.env, ...env },
    stdio: "ignore",
  });
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/vision`, { method: "POST", body: "{}", signal: AbortSignal.timeout(700) });
      r.body?.cancel?.();
      break;
    } catch {
      await sleep(700);
    }
  }
  return child;
}

const out = {};

// ---- 1. No provider configured → 503 ----
const portA = 9521;
const childA = await startServer(portA, { VA_VISION_SKIP: "1" });
const probePayload = () => fetch(`http://127.0.0.1:${portA}/api/vision`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ imageBase64: BASE64_1PX, mimeType: "image/png" }),
});
const r1 = await probePayload();
out.noProvider = { status: r1.status, body: await r1.json() };

// ---- 2. Bad input → 400 ----
const r2 = await fetch(`http://127.0.0.1:${portA}/api/vision`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ imageBase64: "!!!not-base64!!!", mimeType: "image/png" }),
});
out.badBase64 = { status: r2.status, body: await r2.json() };
const r2b = await fetch(`http://127.0.0.1:${portA}/api/vision`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ imageBase64: BASE64_1PX, mimeType: "image/tiff" }),
});
out.badMime = { status: r2b.status, body: await r2b.json() };
childA.kill();

// ---- 3. Provider configured but unreachable → 502 network ----
const portB = 9522;
const childB = await startServer(portB, {
  VISION_API_BASE: "http://127.0.0.1:1/v1/chat/completions",
  VISION_API_KEY: "test-key",
  VISION_MODEL: "gpt-4o-mini",
});
const r3 = await fetch(`http://127.0.0.1:${portB}/api/vision`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ imageBase64: BASE64_1PX, mimeType: "image/png" }),
});
out.providerUnreachable = { status: r3.status, body: await r3.json() };
childB.kill();

// ---- REAL call when key present (optional) ----
const hasRealKey = !!process.env.VA_VISION_BASE && !!process.env.VA_VISION_KEY;
if (hasRealKey) {
  const { readFile } = await import("node:fs/promises");
  const buf = await readFile(FIXTURE);
  const b64 = buf.toString("base64");
  const realPort = 9523;
  const childReal = await startServer(realPort, {
    VISION_API_BASE: process.env.VA_VISION_BASE,
    VISION_API_KEY: process.env.VA_VISION_KEY,
    VISION_MODEL: process.env.VA_VISION_MODEL || "gpt-4o-mini",
  });
  try {
    const rr = await fetch(`http://127.0.0.1:${realPort}/api/vision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageBase64: b64, mimeType: "image/jpeg" }),
      signal: AbortSignal.timeout(90_000),
    });
    const data = await rr.json();
    let pipeline = null;
    if (rr.status === 200 && data.ok) {
      const { normalizeVisionIntent } = await import("../src/services/vision/normalizeVisionIntent.js");
      const intent = normalizeVisionIntent(data.intent);
      const { retrieveByIntent } = await import("../src/services/retrieval/retrievalService.js");
      pipeline = {
        intentOk: !!intent,
        results: intent ? retrieveByIntent(intent, { limit: 3 }).length : 0,
      };
    }
    out.realCall = { status: rr.status, body: data, pipeline, latencyMs: data.latencyMs ?? null };
  } finally {
    childReal.kill();
  }
} else {
  out.realCall = { skipped: true, note: "no VA_VISION_BASE/KEY configured — REAL PROVIDER BLOCKED" };
}

out.verdicts = {
  noProvider503: out.noProvider?.status === 503 && out.noProvider?.body?.error?.code === "provider-not-configured",
  badBase64400: out.badBase64?.status === 400 && out.badBase64?.body?.error?.code === "invalid-base64",
  badMime400: out.badMime?.status === 400 && out.badMime?.body?.error?.code === "unsupported-format",
  providerCallProof: out.providerUnreachable?.status === 502 && out.providerUnreachable?.body?.error?.code === "network",
};

out.status = hasRealKey
  ? out.realCall?.status === 200 && out.realCall?.pipeline?.results > 0
    ? "REAL PROVIDER PASS"
    : "REAL PROVIDER FAIL"
  : "REAL PROVIDER BLOCKED";

await writeFile(path.join(__dirname, "real-bridge-test.json"), JSON.stringify(out, null, 2));
console.log("REAL BRIDGE TEST -> " + out.status);
for (const [k, v] of Object.entries(out.verdicts)) console.log(`  ${k}: ${v ? "pass" : "FAIL"}`);
process.exit(out.status === "REAL PROVIDER FAIL" ? 1 : 0);