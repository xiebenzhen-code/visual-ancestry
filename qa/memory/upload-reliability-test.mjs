// P5.1.8 — upload-reliability-test.mjs · offline upload STATE QA (STEP 5).
//
// Validates the P5.1.8 upload state machine (pending/processing/success/failed)
// and error classification WITHOUT any provider: the transport is an injected,
// controlled bridge fake (a stubbed global fetch). Nothing is mocked on the
// product side — uploadBytes, sha256, normalizeVisionIntent, createVisualMemory
// and the repository all run their real code.
//
// Cases (STEP 5 spec):
//   Case 1 正常上传    → image bytes → VisualMemory(status=success)
//   Case 2 Vision 失败 → failure PERSISTS as a failed entry; no fabricated
//                         success asset is ever created; placeholder intent
//                         (source:"empty") is not retrieval material
//   Case 3 Retry       → failed → re-analyze with the SAME id → success (upsert)
//   Case 4 批量混合    → 10 uploads with mixed outcomes → per-item status right
//
// Uses a TEMP store dir (MEMORY_STORE_DIR) — never touches real user data,
// never calls the network.
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Same legal VisualIntent payload shape the frozen bridge returns on success.
function validIntentRaw() {
  return {
    emotion: ["平静"],
    atmosphere: ["空旷", "寂静"],
    subject: "place",
    subjectScale: "small",
    subjectPosition: "center",
    spatialDepth: "deep",
    negativeSpace: "high",
    environmentDominance: "high",
    lightDirection: "side",
    lightQuality: "diffuse",
    colorTemperature: "cool",
    saturation: "low",
    contrast: "medium",
    humanRelation: "isolated",
    cameraDistance: "far",
    cameraHeight: "eye",
    cameraRelation: "observational",
    motion: "still",
    visualDensity: "sparse",
    arousal: "low",
    socialDistance: "high",
    melancholy: "low",
  };
}

// ---- controlled transport ------------------------------------------------
// A scripted bridge: each step is
//   { kind:"ok", status:200 }
//   { kind:"fail", status, code }     (e.g. 502 invalid-json, 503 unavailable)
//   { kind:"timeout" }                (60s fetch abort style)
function makeBridge(script) {
  let i = 0;
  const calls = [];
  const bridge = async (url, opts) => {
    calls.push({ url: String(url), hasBody: !!opts && !!opts.body });
    const step = script[Math.min(i, script.length - 1)];
    i += 1;
    if (step.kind === "timeout") {
      throw new Error("The operation was aborted due to timeout");
    }
    const payload =
      step.kind === "ok"
        ? { ok: true, intent: validIntentRaw(), latencyMs: 23 }
        : { ok: false, error: { code: step.code } };
    return {
      status: step.status,
      ok: step.status === 200,
      json: async () => payload,
    };
  };
  bridge.calls = calls;
  return bridge;
}

async function run() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "p518-upload-"));
  process.env.MEMORY_STORE_DIR = tmp; // before first import of repository
  const { uploadBytes, UPLOAD_ERRORS } = await import(
    pathToFileURL(path.join(__dirname, "..", "..", "src", "services", "memory", "uploadService.js")).href
  );
  const { listMemories, getMemory } = await import(
    pathToFileURL(path.join(__dirname, "..", "..", "src", "services", "memory", "memoryRepository.js")).href
  );

  const checks = [];
  const ok = (name, cond) => {
    checks.push([name, !!cond]);
    console.log(`  ${cond ? "PASS" : "FAIL"} ${name}`);
  };

  const jpeg = Buffer.alloc(1536); // size/mime matter; content never reaches a provider
  const base = "http://test-bridge.local";

  // ---- Case 1: normal upload → success VisualMemory ----------------------
  console.log("\nCase 1 · 正常上传 (image → VisualMemory success)");
  {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeBridge([{ kind: "ok", status: 200 }]);
    try {
      const r = await uploadBytes(jpeg, "image/jpeg", { base, title: "雾中的车站", origin: "film-still", tags: ["夜晚"], note: "想留住这一刻" });
      ok("returns ok:true + memory", r.ok === true && !!r.memory);
      ok("status=success", r.memory.status === "success");
      ok("visualIntent.source=vision (real reading)", r.memory.visualIntent.source === "vision" && r.memory.visualIntent.subject === "place");
      ok("error=null on success", r.memory.error === null);
      ok("metadata title kept", r.memory.metadata.title === "雾中的车站");
      const stored = await getMemory(r.memory.id);
      ok("persisted & retrievable", !!stored && stored.status === "success");
      const leaked = Object.keys(stored.visualIntent).filter((k) => ["title", "origin", "tags", "note", "createdAt"].includes(k));
      ok("metadata/note NOT leaked into visualIntent", leaked.length === 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  // ---- Case 2: Vision failure → honest failed entry, no fake asset -------
  console.log("\nCase 2 · Vision 失败 (502 invalid-json → no fabricated success)");
  {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeBridge([{ kind: "fail", status: 502, code: "invalid-json" }]);
    try {
      const r = await uploadBytes(jpeg, "image/jpeg", { base, id: "vm-fail-01", title: "失败样例", origin: "photo" });
      ok("returns ok:false", r.ok === false);
      ok("classified error code", r.error && r.error.code === "VISION_INVALID_RESPONSE");
      ok("error carries Chinese user message", /重新尝试/.test(r.error.message));
      ok("error marks retryable=true", r.error.retryable === true);

      const stored = await getMemory("vm-fail-01");
      ok("failure PERSISTS as failed entry (visible)", !!stored && stored.status === "failed");
      ok("no fabricated success asset", stored.status !== "success");
      ok("placeholder intent source=empty (not retrieval material)", stored.visualIntent.source === "empty");
      ok("error stored on entry", stored.error && stored.error.code === "VISION_INVALID_RESPONSE");

      const all = await listMemories();
      const failedOnes = all.filter((m) => m.status === "failed");
      ok("only failed entry is the expected one (no dupes)", failedOnes.length === 1 && failedOnes[0].id === "vm-fail-01");
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  // ---- Case 3: retry with same id → failed → success (upsert) ------------
  console.log("\nCase 3 · Retry (失败 → 重新分析同 id 覆盖 → success)");
  {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeBridge([
      { kind: "fail", status: 502, code: "invalid-json" },
      { kind: "ok", status: 200 },
    ]);
    try {
      const first = await uploadBytes(jpeg, "image/jpeg", { base, id: "vm-retry-01", title: "重试样例", origin: "artwork-reference" });
      ok("first attempt fails", first.ok === false);

      const second = await uploadBytes(jpeg, "image/jpeg", { base, id: "vm-retry-01", title: "重试样例", origin: "artwork-reference" });
      ok("retry succeeds", second.ok === true && second.memory.status === "success");

      const all = await listMemories();
      const retried = all.filter((m) => m.id === "vm-retry-01");
      ok("same id → upsert, still ONE entry", retried.length === 1);
      ok("entry flipped to success (recovered)", retried.length === 1 && retried[0].status === "success");
      ok("retried intent is real (source=vision)", all[0].visualIntent.source === "vision");
      ok("stale error cleared", all[0].error === null);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  // ---- Case 4: batch 10, mixed outcomes → per-item state correct ---------
  console.log("\nCase 4 · 批量 10 张混合（成功/失败交错）");
  {
    const script = [
      { kind: "ok", status: 200 },
      { kind: "fail", status: 502, code: "invalid-json" },
      { kind: "ok", status: 200 },
      { kind: "timeout" },
      { kind: "ok", status: 200 },
      { kind: "fail", status: 503, code: "vision-unavailable" },
      { kind: "ok", status: 200 },
      { kind: "fail", status: 502, code: "invalid-json" },
      { kind: "ok", status: 200 },
      { kind: "ok", status: 200 },
    ];
    const expects = ["success", "failed", "success", "failed", "success", "failed", "success", "failed", "success", "success"];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeBridge(script);
    try {
      const results = [];
      for (let i = 0; i < 10; i += 1) {
        const r = await uploadBytes(jpeg, "image/jpeg", { base, id: `vm-batch-${String(i + 1).padStart(2, "0")}`, title: `批量 ${i + 1}`, origin: "photo" });
        results.push(r.ok ? "success" : "failed");
      }
      ok("per-call status matches script", JSON.stringify(results) === JSON.stringify(expects));

      const all = await listMemories();
      const batchOnes = all.filter((m) => m.id.startsWith("vm-batch-"));
      ok("exactly 10 persisted", batchOnes.length === 10);
      const mismatches = batchOnes.filter((m) => m.status !== expects[Number(m.id.slice(-2)) - 1]).map((m) => `${m.id}:${m.status}`);
      ok("persisted statuses match expectations", mismatches.length === 0);
      const failedOnes = batchOnes.filter((m) => m.status === "failed");
      ok("failed entries carry classified code+message", failedOnes.every((m) => m.error && m.error.code && m.error.message));
      ok("failed entry intents are placeholders only", failedOnes.every((m) => m.visualIntent.source === "empty"));
      const successOnes = batchOnes.filter((m) => m.status === "success");
      ok("success entries keep real intent", successOnes.every((m) => m.visualIntent.source === "vision"));
      ok("success/failed counts (6/4)", successOnes.length === 6 && failedOnes.length === 4);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  await rm(tmp, { recursive: true, force: true });
  const failed = checks.filter(([, c]) => !c);
  console.log(`\nP5.1.8 upload-reliability-test: ${checks.length - failed.length}/${checks.length} PASS`);
  return failed.length === 0 ? 0 : 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  run().then((code) => process.exit(code)).catch((e) => { console.error(e); process.exit(1); });
}