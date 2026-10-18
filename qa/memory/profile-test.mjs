// P5.3.1 STEP 5 — profile aggregator QA (4 cases, zero mock, zero provider).
// Case 1 runs against the REAL P5.2.4 pool (read-only) and checks the exact
// counts measured in P5.3.0; Cases 2-4 inject controlled memories into the
// pure aggregator. Namespace discipline follows the P5.1.8 pattern.
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const P524_STORE = path.join(ROOT, "work", "p5.2.4-usage-validation", "store");
const OUT = path.join(ROOT, "work", "p5.3.1-profile", "profile-test-results.json");

process.env.MEMORY_STORE_DIR = P524_STORE; // Case 1 reads the real pool read-only

const { aggregateVisualProfile, getConfidence, isProfileEligible } = await import(
  pathToFileURL(path.join(ROOT, "src", "services", "memory", "visualProfile.js")).href
);
const { listMemories } = await import(
  pathToFileURL(path.join(ROOT, "src", "services", "memory", "memoryRepository.js")).href
);

const results = [];
let pass = 0;
let fail = 0;
function check(caseName, desc, cond, detail) {
  if (cond) { pass++; results.push({ caseName, desc, pass: true }); console.log(`  ✓ ${desc}`); }
  else { fail++; results.push({ caseName, desc, pass: false, detail }); console.log(`  ✗ ${desc}${detail ? " · " + detail : ""}`); }
}

// ---- helper: build a minimal eligible memory --------------------------------
function mem(id, overrides = {}) {
  return {
    id,
    status: "success",
    visualIntent: { source: "vision", ...(overrides.intent || {}) },
    metadata: { title: overrides.title || "", tags: overrides.tags || [] },
    ...overrides.extra,
  };
}

// ============================ Case 1: real pool ==============================
console.log("Case 1 — 19 success 真实池聚合正确（对照 P5.3.0 实测）");
{
  const all = await listMemories();
  const p = aggregateVisualProfile(all);
  check("case1", "sampleSize = 19", p.sampleSize === 19, `got ${p.sampleSize}`);
  check("case1", "failed (uv-b06) 被排除", !all.some((m) => m.id === "uv-b06" && isProfileEligible(m)));
  check("case1", "deepSpace = 16/0.84", p.spatial.deepSpace.count === 16 && p.spatial.deepSpace.ratio === 0.84, JSON.stringify(p.spatial.deepSpace));
  check("case1", "environmentDominant = 12/0.63", p.spatial.environmentDominant.count === 12 && p.spatial.environmentDominant.ratio === 0.63, JSON.stringify(p.spatial.environmentDominant));
  check("case1", "lowSaturation = 16/0.84", p.color.lowSaturation.count === 16 && p.color.lowSaturation.ratio === 0.84, JSON.stringify(p.color.lowSaturation));
  check("case1", "highContrast = 15/0.79", p.color.highContrast.count === 15 && p.color.highContrast.ratio === 0.79, JSON.stringify(p.color.highContrast));
  check("case1", "isolation = 11/0.58", p.narrative.isolation.count === 11 && p.narrative.isolation.ratio === 0.58, JSON.stringify(p.narrative.isolation));
  check("case1", "farCamera = 10/0.53", p.composition.farCamera.count === 10 && p.composition.farCamera.ratio === 0.53, JSON.stringify(p.composition.farCamera));
  check("case1", "confidence = observation (19<20)", p.confidence.level === "observation" && p.confidence.basis === "based on 19 visual memories", JSON.stringify(p.confidence));
  check("case1", "atmosphere 空旷 token = 8", p.atmosphereTokens["空旷"] === 8, JSON.stringify(p.atmosphereTokens));
  check("case1", "unavailable 含 emotion / composition / geometry", !!(p.unavailable.emotion && p.unavailable.composition && p.unavailable.geometry), JSON.stringify(p.unavailable));
}

// ===================== Case 2: failed memory 不进入统计 ======================
console.log("Case 2 — failed memory 不进入统计");
{
  const good = mem("ok-1", { intent: { spatialDepth: "deep" } });
  const failed = { id: "fail-1", status: "failed", visualIntent: { source: "empty" }, metadata: {} };
  const emptySrc = mem("empty-1", { intent: { spatialDepth: "deep" } });
  emptySrc.visualIntent.source = "empty";
  const example = mem("ex-1", { intent: { spatialDepth: "deep" } });
  example.visualIntent.source = "example";
  const p = aggregateVisualProfile([good, failed, emptySrc, example]);
  check("case2", "sampleSize = 1（仅 success 非 empty/example）", p.sampleSize === 1, `got ${p.sampleSize}`);
  check("case2", "deepSpace 只计 1 次", p.spatial.deepSpace.count === 1, JSON.stringify(p.spatial.deepSpace));
}

// ===================== Case 3: metadata 污染不参与 ===========================
console.log("Case 3 — metadata 污染（title/tags 有词但 intent 没有）不参与");
{
  const dirty = mem("dirty-1", {
    title: "孤独夜晚城市",
    tags: ["孤独", "夜晚", "孤立"],
    intent: { spatialDepth: "deep", saturation: "low" }, // intent 无 isolation / 夜晚
  });
  const p = aggregateVisualProfile([dirty]);
  check("case3", "isolation.count = 0（title 里的「孤独」不计入）", p.narrative.isolation.count === 0, JSON.stringify(p.narrative.isolation));
  check("case3", "atmosphereTokens 不含「夜晚」", !(p.atmosphereTokens["夜晚"] > 0), JSON.stringify(p.atmosphereTokens));
  check("case3", "isolation.ratio = 0 而非凭空比例", p.narrative.isolation.ratio === 0);
}

// ===================== Case 4: 空池 ==========================================
console.log("Case 4 — 空池诚实返回");
{
  const p = aggregateVisualProfile([]);
  check("case4", "sampleSize = 0", p.sampleSize === 0);
  check("case4", "confidence = empty", p.confidence.level === "empty", JSON.stringify(p.confidence));
  check("case4", "deepSpace = 0/0.00（不抛错）", p.spatial.deepSpace.count === 0 && p.spatial.deepSpace.ratio === 0);
  check("case4", "非 null/undefined 输入以外（null 安全）", aggregateVisualProfile(null).sampleSize === 0);
}

// ===================== Confidence 边界 =======================================
console.log("Confidence 边界（0/1/19/20/50/51）");
check("conf", "0 → empty", getConfidence(0).level === "empty");
check("conf", "1 → observation", getConfidence(1).level === "observation");
check("conf", "19 → observation", getConfidence(19).level === "observation");
check("conf", "20 → tendency", getConfidence(20).level === "tendency");
check("conf", "50 → tendency", getConfidence(50).level === "tendency");
check("conf", "51 → pattern", getConfidence(51).level === "pattern");

console.log(`\n==== ${pass} PASS / ${fail} FAIL ====`);
const summary = { total: pass + fail, pass, fail, results };
await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(summary, null, 2) + "\n", "utf8");
console.log(`results → ${OUT}`);
process.exit(fail > 0 ? 1 : 0);
