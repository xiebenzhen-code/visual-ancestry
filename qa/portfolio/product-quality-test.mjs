// P5.4 STEP 2 — product quality test (Cases A-E, pure injection, zero provider).
// A: empty pool → honest empty (no fabricated trends)
// B: 5 assets → confidence = observation
// C: 30 assets → confidence = tendency
// D: failed memories excluded from retrieval AND profile
// E: metadata pollution (title/tags) cannot leak into search or profile
import { writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const OUT = path.join(ROOT, "work", "portfolio-validation", "product-quality-results.json");
// no store needed — everything is pure injection; still set a temp dir so any
// accidental store access is visible instead of silently hitting the default
// IDEMPOTENCY: Case D retrieval reads the WHOLE store (not injectable), so a
// fixed temp dir must be cleared before each run or entries left by a previous
// run (e.g. e-clean) leak into Case D's "only d-good" assertion.
const TEMP_STORE = path.join(ROOT, "work", "portfolio-validation", "quality-temp-store");
await rm(TEMP_STORE, { recursive: true, force: true });
process.env.MEMORY_STORE_DIR = TEMP_STORE;

const { aggregateVisualProfile, getConfidence } = await import(
  pathToFileURL(path.join(ROOT, "src", "services", "memory", "visualProfile.js")).href
);
const { retrieveVisualMemory, isRetrievable } = await import(
  pathToFileURL(path.join(ROOT, "src", "services", "memory", "retrieveVisualMemory.js")).href
);
const { profileSections } = await import(
  pathToFileURL(path.join(ROOT, "src", "components", "memory", "visualProfilePresenter.js")).href
);

const results = [];
let pass = 0, fail = 0;
const check = (caseName, desc, cond, detail) => {
  if (cond) { pass++; results.push({ caseName, desc, pass: true }); console.log(`  ✓ ${desc}`); }
  else { fail++; results.push({ caseName, desc, pass: false, detail: detail || "" }); console.log(`  ✗ ${desc}${detail ? " · " + detail : ""}`); }
};

function mem(id, { intent = {}, title = "", tags = [], status = "success" } = {}) {
  return { id, status, metadata: { title, tags, origin: "artwork-reference" }, visualIntent: { source: "vision", ...intent } };
}
// a realistic deep-space lonely asset
const deep = (id, extra = {}) => mem(id, {
  intent: { spatialDepth: "deep", environmentDominance: "high", negativeSpace: "high", saturation: "low", humanRelation: "isolated", socialDistance: "high" },
  ...extra,
});

// ============================ Case A: empty ==================================
console.log("Case A — 空数据：诚实 empty，不生成虚假趋势");
{
  const p = aggregateVisualProfile([]);
  check("A", "sampleSize = 0", p.sampleSize === 0);
  check("A", "confidence = empty", p.confidence.level === "empty");
  check("A", "所有 ratio = 0（无凭空趋势）", Object.values(p.spatial).every((s) => s.ratio === 0) && Object.values(p.narrative).every((s) => s.ratio === 0));
  check("A", "presenter 无任何主张（sections 空）", profileSections(p).length === 0);
}

// ============================ Case B: 5 assets ===============================
console.log("Case B — 小数据（5 assets）：confidence = observation");
{
  const pool = Array.from({ length: 5 }, (_, i) => deep(`b-${i}`));
  const p = aggregateVisualProfile(pool);
  check("B", "sampleSize = 5", p.sampleSize === 5);
  check("B", "confidence = observation", p.confidence.level === "observation", p.confidence.level);
  check("B", "basis 显示样本量", p.confidence.basis === "based on 5 visual memories");
}

// ============================ Case C: 30 assets ==============================
console.log("Case C — 中规模（30 assets）：confidence = tendency");
{
  const pool = Array.from({ length: 30 }, (_, i) => deep(`c-${i}`));
  const p = aggregateVisualProfile(pool);
  check("C", "sampleSize = 30", p.sampleSize === 30);
  check("C", "confidence = tendency", p.confidence.level === "tendency", p.confidence.level);
  check("C", "20/50 边界（20→tendency, 50→tendency, 51→pattern）", getConfidence(20).level === "tendency" && getConfidence(50).level === "tendency" && getConfidence(51).level === "pattern");
}

// ============================ Case D: failed filtering =======================
console.log("Case D — 失败数据不进入 Retrieval 与 Profile");
{
  // retrieval reads the store (not injectable) — seed the temp store first
  const { addMemory } = await import(
    pathToFileURL(path.join(ROOT, "src", "services", "memory", "memoryRepository.js")).href
  );
  const good = deep("d-good");
  const failed = mem("d-failed", { status: "failed", intent: {} }); // failed → empty intent placeholder
  const emptySrc = mem("d-empty", { intent: { spatialDepth: "deep" } });
  emptySrc.visualIntent.source = "empty";
  for (const m of [good, failed, emptySrc]) await addMemory(m);
  check("D", "isRetrievable 拒绝 failed/empty-source", !isRetrievable(failed) && !isRetrievable(emptySrc) && isRetrievable(good));
  const p = aggregateVisualProfile([good, failed, emptySrc]);
  check("D", "Profile 只计 1 条", p.sampleSize === 1, `got ${p.sampleSize}`);
  const hit = await retrieveVisualMemory({ spatialDepth: "deep", environmentDominance: "high" }, { limit: 10 });
  check("D", "Retrieval 只返回 good（failed/empty 被准入过滤）", hit.length === 1 && hit[0].id === "d-good", `got ${hit.length}: ${hit.map((h) => h.id).join(",")}`);
}

// ============================ Case E: metadata pollution =====================
console.log("Case E — Metadata 污染（title/tags 有词，intent 无）");
{
  const { addMemory } = await import(
    pathToFileURL(path.join(ROOT, "src", "services", "memory", "memoryRepository.js")).href
  );
  const clean = deep("e-clean");
  const dirty = mem("e-dirty", {
    title: "孤独夜晚城市 环境主导 低饱和",
    tags: ["孤独", "深空间", "孤立", "环境主导"],
    intent: { subject: "place", motion: "still" }, // none of the query fields
  });
  for (const m of [clean, dirty]) await addMemory(m);
  const hit = await retrieveVisualMemory({ spatialDepth: "deep", environmentDominance: "high", humanRelation: "isolated", saturation: "low" }, { limit: 10 });
  check("E", "检索不含 dirty（metadata 不参与）", !hit.some((h) => h.id === "e-dirty"), hit.map((h) => h.id).join(","));
  check("E", "检索返回 clean", hit.some((h) => h.id === "e-clean"));
  const p = aggregateVisualProfile([clean, dirty]);
  check("E", "Profile isolation 不受 title「孤独」影响（仅 clean 计 1）", p.narrative.isolation.count === 1, JSON.stringify(p.narrative.isolation));
  check("E", "Profile deepSpace 不受 tags「深空间」影响（仅 clean 计 1）", p.spatial.deepSpace.count === 1, JSON.stringify(p.spatial.deepSpace));
  check("E", "Profile atmosphereTokens 无「孤独/夜晚」（metadata 不进统计）", !(p.atmosphereTokens["孤独"] > 0) && !(p.atmosphereTokens["夜晚"] > 0), JSON.stringify(p.atmosphereTokens));
}

console.log(`\n==== ${pass} PASS / ${fail} FAIL ====`);
await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify({ total: pass + fail, pass, fail, results }, null, 2) + "\n", "utf8");
console.log(`→ ${OUT}`);
process.exit(fail > 0 ? 1 : 0);
