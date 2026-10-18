// P5.2.2 — product-flow-test.mjs · end-to-end product flow QA (STEP 5).
//
// Validates the packaged loop users experience:
//   upload → saved → search by feeling → retrieval evidence → refresh persists
// Zero provider calls: the transport is an injected, controlled bridge fake
// (same pattern as upload-reliability-test.mjs); every product/service module
// runs its real code. Uses a TEMP store — never touches user data.
//
// Cases:
//   Case 1 上传→保存→搜索 — a stored memory is retrievable via visual query
//   Case 2 无结果查询     — honest empty outcome, no forced recommendation
//   Case 3 失败资产       — status=failed never enters results
//   Case 4 刷新           — data persists across a fresh repository read
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");

function validIntentRaw() {
  return {
    emotion: ["平静"],
    atmosphere: ["寂静", "空旷"],
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

function makeBridge(script) {
  let i = 0;
  const bridge = async () => {
    const step = script[Math.min(i, script.length - 1)];
    i += 1;
    if (step.kind === "timeout") throw new Error("The operation was aborted due to timeout");
    const payload = step.kind === "ok"
      ? { ok: true, intent: validIntentRaw(), latencyMs: 12 }
      : { ok: false, error: { code: step.code } };
    return { status: step.status, ok: step.status === 200, json: async () => payload };
  };
  return bridge;
}

async function run() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "p522-flow-"));
  process.env.MEMORY_STORE_DIR = tmp;
  const { uploadBytes } = await import(
    pathToFileURL(path.join(ROOT, "src", "services", "memory", "uploadService.js")).href
  );
  const { getMemory, listMemories } = await import(
    pathToFileURL(path.join(ROOT, "src", "services", "memory", "memoryRepository.js")).href
  );
  const { retrieveVisualMemory } = await import(
    pathToFileURL(path.join(ROOT, "src", "services", "memory", "retrieveVisualMemory.js")).href
  );
  const { createVisualMemory } = await import(
    pathToFileURL(path.join(ROOT, "src", "services", "memory", "types.js")).href
  );
  const { normalizeVisionIntent } = await import(
    pathToFileURL(path.join(ROOT, "src", "services", "vision", "normalizeVisionIntent.js")).href
  );

  const checks = [];
  const ok = (name, cond) => {
    checks.push([name, !!cond]);
    console.log(`  ${cond ? "PASS" : "FAIL"} ${name}`);
  };

  const jpeg = Buffer.alloc(2048);
  const base = "http://test-bridge.local";
  const originalFetch = globalThis.fetch;

  // ---- Case 1: upload → saved → search by feeling → found -----------------
  console.log("\nCase 1 · 上传 → 保存 → 搜索（能找回）");
  {
    globalThis.fetch = makeBridge([{ kind: "ok", status: 200 }]);
    try {
      const r = await uploadBytes(jpeg, "image/jpeg", {
        base, id: "flow-01", title: "雾中的车站", origin: "film-still",
        note: "孤独夜晚的车站", tags: [],
      });
      ok("upload saves a success memory", r.ok === true && r.memory.status === "success");
      const stored = await getMemory("flow-01");
      ok("memory persisted", !!stored && stored.metadata.title === "雾中的车站");

      // search by feeling (structured query, schema tokens)
      const results = await retrieveVisualMemory(
        normalizeVisionIntent({ atmosphere: ["寂静"], spatialDepth: "deep", negativeSpace: "high", saturation: "low" }),
        { limit: 5 }
      );
      const found = results.find((x) => x.id === "flow-01");
      ok("visual query retrieves the saved memory", !!found);
      ok("evidence explains why (reasons non-empty)", found && found.reasons.length > 0);
      ok("evidence lists matched fields", found && found.matchedFields.includes("atmosphere"));
      ok("score > 0 for a real match", found && found.score > 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  // ---- Case 2: no-match query → honest empty outcome ----------------------
  console.log("\nCase 2 · 无结果查询（不强行推荐）");
  {
    const results = await retrieveVisualMemory(
      normalizeVisionIntent({ atmosphere: ["热闹"], saturation: "high", humanRelation: "crowd", motion: "moving" }),
      { limit: 5 }
    );
    ok("returns empty for a genuinely absent feeling", results.length === 0);
    ok("does not fabricate any recommendation", results.length === 0);
  }

  // ---- Case 3: failed asset never enters results --------------------------
  console.log("\nCase 3 · 失败资产（不进入结果）");
  {
    await addFailed(createVisualMemory, {
      id: "flow-fail", status: "failed",
      error: { code: "VISION_INVALID_RESPONSE", message: "AI 分析失败，请重新尝试。" },
      image: { path: "f.jpg", mime: "image/jpeg", sha256: "x" },
      metadata: { title: "失败项", origin: "photo", tags: [], createdAt: "2026-10-01T00:00:00Z" },
      visualIntent: normalizeVisionIntent({ atmosphere: ["寂静"], spatialDepth: "deep" }),
      userData: {},
    });
    const results = await retrieveVisualMemory(
      normalizeVisionIntent({ atmosphere: ["寂静"], spatialDepth: "deep", negativeSpace: "high", saturation: "low" }),
      { limit: 5 }
    );
    ok("failed entry excluded even when intent matches", !results.some((x) => x.id === "flow-fail"));
  }

  // ---- Case 4: refresh → data persists ------------------------------------
  console.log("\nCase 4 · 刷新（数据仍存在）");
  {
    // fresh repository read (equivalent of a page refresh reloading the store)
    const raw = await readFile(path.join(tmp, "memories.json"), "utf8");
    const parsed = JSON.parse(raw);
    ok("store file contains flow-01 after refresh", parsed.memories.some((m) => m.id === "flow-01"));
    ok("failed asset also persisted (visible, not erased)", parsed.memories.some((m) => m.id === "flow-fail" && m.status === "failed"));
    const again = await listMemories();
    ok("listMemories re-reads persisted data", again.some((m) => m.id === "flow-01"));
    // browser-side refresh persistence is covered separately (browser-store-test 6/6)
  }

  await rm(tmp, { recursive: true, force: true });
  const failed = checks.filter(([, c]) => !c);
  console.log(`\nP5.2.2 product-flow-test: ${checks.length - failed.length}/${checks.length} PASS`);
  return failed.length === 0 ? 0 : 1;
}

async function addFailed(createVisualMemory, input) {
  const { addMemory } = await import(
    pathToFileURL(path.join(ROOT, "src", "services", "memory", "memoryRepository.js")).href
  );
  await addMemory(createVisualMemory(input));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  run().then((code) => process.exit(code)).catch((e) => { console.error(e); process.exit(1); });
}