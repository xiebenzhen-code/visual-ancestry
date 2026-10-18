// REAL Vision smoke — fixed test image, real provider call.
//
// This is the REAL-PROVIDER QA, deliberately separate from the mock QA.
// It resolves provider config (qa/.vision-config.json OR VA_VISION_* env),
// then calls the actual single wired provider (callVisionProvider) from Node
// with the fixed fixture.
//
// If no config exists the test reports REAL PROVIDER: BLOCKED with the exact
// reasons and exits 0 — an honest BLOCKED, never a fake PASS.
//
// Writes qa/real-vision-smoke.json
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { callVisionProvider } from "../src/services/vision/visionProvider.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const OUT = path.join(__dirname, "real-vision-smoke.json");
const FIXTURE = path.join(__dirname, "fixtures", "vision-probe.jpg");
const FIXTURE_W = 640;
const FIXTURE_H = 480;

// ---- Config resolution: qa/.vision-config.json first, then env vars -------
const loaded = { endpoint: "", apiKey: "", model: "" };
try {
  const cfg = JSON.parse(await readFile(path.join(__dirname, ".vision-config.json"), "utf8"));
  loaded.endpoint = String(cfg.endpoint || "");
  loaded.apiKey = String(cfg.apiKey || "");
  loaded.model = String(cfg.model || "");
} catch {
  /* optional config file absent */
}
const config = {
  endpoint: loaded.endpoint || process.env.VA_VISION_ENDPOINT || "",
  apiKey: loaded.apiKey || process.env.VA_VISION_API_KEY || "",
  model: loaded.model || process.env.VA_VISION_MODEL || "",
};

// ---- Honest environment findings (why BLOCKED if no config) ----------------
const envFacts = [
  "no .env file exists in the project (only .env.example with empty slots)",
  "VITE_AI_API_ENDPOINT is declared in .env.example but consumed by zero code (grep of src/ + scripts/ found no provider/env reads)",
  "package.json has no OpenAI/Gemini/OpenRouter SDK deps (native fetch only)",
  "src/config.js is empty: 'export const config = {}' with comment 'No secrets in the repo'",
  "loaded provider config: endpoint/apiKey " + (config.endpoint && config.apiKey ? "PRESENT" : "ABSENT"),
];

const blocked = !config.endpoint || !config.apiKey;
const reasons = [];
if (!config.endpoint) reasons.push("no provider endpoint configured (VA_VISION_ENDPOINT / qa/.vision-config.json)");
if (!config.apiKey) reasons.push("no provider api key configured (VA_VISION_API_KEY / qa/.vision-config.json)");

let result;
if (blocked) {
  result = {
    suite: "REAL PROVIDER QA",
    realProvider: "BLOCKED",
    ts: new Date().toISOString(),
    fixture: "qa/fixtures/vision-probe.jpg",
    fixtureDims: `${FIXTURE_W}x${FIXTURE_H}`,
    reasons,
    envFacts,
    note: "Honest BLOCKED per V5.1 P2 rules — no fake PASS. Provide VA_VISION_ENDPOINT + VA_VISION_API_KEY (or qa/.vision-config.json) and re-run to execute a real call against the single wired provider.",
  };
} else {
  const buf = await readFile(FIXTURE);
  const blob = new Blob([buf], { type: "image/jpeg" });
  try {
    const out = await callVisionProvider(blob, config, { timeoutMs: 60000, inputW: FIXTURE_W, inputH: FIXTURE_H });
    result = {
      suite: "REAL PROVIDER QA",
      realProvider: out.ok ? "PASS" : "FAIL",
      ts: new Date().toISOString(),
      fixture: "qa/fixtures/vision-probe.jpg",
      fixtureDims: `${FIXTURE_W}x${FIXTURE_H}`,
      model: config.model || "(default)",
      latencyMs: out.latencyMs ?? null,
      ...(out.ok
        ? { raw: out.raw, intentKeys: out.raw ? Object.keys(out.raw) : [] }
        : { error: out.error, reason: out.reason }),
    };
  } catch (err) {
    result = {
      suite: "REAL PROVIDER QA",
      realProvider: "FAIL",
      ts: new Date().toISOString(),
      fixture: "qa/fixtures/vision-probe.jpg",
      error: String((err && err.stack) || err),
    };
  }
}

await writeFile(OUT, JSON.stringify(result, null, 2));
console.log(`REAL PROVIDER: ${result.realProvider}`);
if (blocked) console.log("reasons: " + reasons.join(" | "));
console.log("result -> " + OUT);
process.exit(0);