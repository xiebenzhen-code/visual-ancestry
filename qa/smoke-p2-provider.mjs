// smoke-p2-provider — MOCK-level contract test for the single wired provider.
// Not the REAL smoke (which needs a live endpoint + key). Here global fetch is
// stubbed to verify request/retry/error-mapping logic of callVisionProvider:
//   success, auth(no retry), transient→retry→success, network fail (exactly
//   2 attempts), invalid JSON (no retry).
// Writes qa/smoke-p2-provider.json
import { writeFileSync } from "node:fs";
import { callVisionProvider } from "../src/services/vision/visionProvider.js";

const CONFIG = { endpoint: "https://mock.test/v1/chat/completions", apiKey: "test-key", model: "gpt-4o-mini" };
const blob = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], { type: "image/jpeg" });

function resp(status, bodyText) {
  return { status, text: async () => bodyText };
}

function contentOf(raw) {
  return JSON.stringify({ choices: [{ message: { content: JSON.stringify(raw) } }] });
}

let fetchCalls = 0;
async function runScenario(name, fetchImpl) {
  fetchCalls = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    fetchCalls += 1;
    return fetchImpl(...args);
  };
  let out;
  try {
    out = await callVisionProvider(blob, CONFIG, { timeoutMs: 5000, inputW: 640, inputH: 480 });
  } finally {
    globalThis.fetch = origFetch;
  }
  const checks = {
    success: out.ok === true && out.raw && out.raw.subjectScale === "small" && fetchCalls === 1,
    authNoRetry: out.ok === false && out.reason === "auth" && fetchCalls === 1,
    retryThenSuccess: out.ok === true && fetchCalls === 2,
    networkFail: out.ok === false && out.reason === "network" && fetchCalls === 2,
    invalidJsonNoRetry: out.ok === false && out.reason === "invalid-json" && fetchCalls === 1,
  };
  const pass = checks[name];
  return { name, pass, ok: out.ok, reason: out.reason, fetchCalls, checks };
}

const results = [];
results.push(await runScenario("success", () => resp(200, contentOf({ subjectScale: "small", cameraRelation: "observational" }))));
results.push(await runScenario("authNoRetry", () => resp(401, '{"error":"bad key"}')));
results.push(await runScenario("retryThenSuccess", () => {
  if (fetchCalls === 1) throw new TypeError("network hiccup");
  return resp(200, contentOf({ spatialDepth: "deep", arousal: "low" }));
}));
results.push(await runScenario("networkFail", () => { throw new TypeError("down"); }));
results.push(await runScenario("invalidJsonNoRetry", () => resp(200, "this is not json")));

const allPass = results.every((r) => r.pass);
writeFileSync("qa/smoke-p2-provider.json", JSON.stringify(results, null, 2));
console.log("SMOKE-P2-PROVIDER " + (allPass ? "PASS" : "FAIL"));
for (const r of results) console.log(`  ${r.name}: ${r.pass ? "pass" : "FAIL"} (ok=${r.ok} reason=${r.reason || "-"} fetchCalls=${r.fetchCalls})`);
process.exit(allPass ? 0 : 1);