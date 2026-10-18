// P5.7 STEP 5 — assistant-workflow-test.mjs · creator-workflow regression.
// Zero provider, zero LLM, zero product-code changes: exercises the frozen
// assistant composition layer the way a creator would.
//
// Store binding (P5.4 lesson): one temp store, bound before first import.
// Case order follows the binding:
//   Case 3 空资产库 (empty store, before seeding)
//   → seed 5 assets → Case 4 Profile 不足 (confidence = observation)
//   → Case 1 正常创作请求 (references > 0, evidence exists)
//   → Case 2 不存在的视觉需求「找粉色未来城市」(honest no match, zero fabrication)
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const SRC = (...p) => pathToFileURL(path.join(ROOT, "src", ...p)).href;
const OUT = path.join(ROOT, "work", "p5.7-workflow", "workflow-test-results.json");

const store = await mkdtemp(path.join(os.tmpdir(), "p57-workflow-"));
process.env.MEMORY_STORE_DIR = store;

const results = [];
let pass = 0, fail = 0;
const check = (caseName, desc, cond, detail) => {
  if (cond) { pass++; results.push({ caseName, desc, pass: true }); console.log(`  ✓ ${desc}`); }
  else { fail++; results.push({ caseName, desc, pass: false, detail: detail || "" }); console.log(`  ✗ ${desc}${detail ? " · " + detail : ""}`); }
};

const { runAssistant } = await import(SRC("services", "memory", "visualAssistant.js"));

// ============================ Case 3: 空资产库 =================================
console.log("Case 3 — 空资产库 → sample insufficient");
{
  const t = await runAssistant({ task: "understand_taste" });
  check("case3", "taste：sampleSize=0 且诚实样本不足", t.ok === false && t.sampleSize === 0 && /没有足够的视觉记忆/.test(t.summary), t.summary);
  const c = await runAssistant({ task: "creative_support", query: "设计一个孤独场景" });
  check("case3", "creative：明确拒绝（不编造方向）", c.ok === false && c.direction === null && /没有足够|不会编造/.test(c.message || ""), c.message);
  const f = await runAssistant({ task: "find_reference", query: "找孤独空间的参考" });
  check("case3", "find：0 结果 + 不强行推荐", f.ok === true && f.results.length === 0 && /不强行推荐/.test(f.note || ""), f.note);
}

// ============================ seed（5 条 → observation 层）=====================
{
  const { addMemory } = await import(SRC("services", "memory", "memoryRepository.js"));
  const mk = (id, intent) => ({ id, status: "success", metadata: { title: `w-${id}`, origin: "artwork-reference" }, visualIntent: { source: "vision", ...intent }, userData: {} });
  const deep = { spatialDepth: "deep", environmentDominance: "high", negativeSpace: "high", saturation: "low", humanRelation: "isolated", socialDistance: "high", atmosphere: ["寂静"] };
  for (const id of ["w1", "w2", "w3", "w4"]) await addMemory(mk(id, deep));
  await addMemory(mk("w5", { spatialDepth: "shallow", saturation: "high", humanRelation: "crowd", colorTemperature: "warm" }));
}

// ============================ Case 4: Profile 不足 =============================
console.log("Case 4 — Profile 不足 → confidence observation");
{
  const r = await runAssistant({ task: "understand_taste" });
  check("case4", "sampleSize=5 → confidence=observation", r.ok && r.sampleSize === 5 && r.confidence.level === "observation", JSON.stringify(r.confidence));
  check("case4", "basis 强制展示 based on 5", /based on 5/.test(r.confidence.basis), r.confidence.basis);
  check("case4", "15 张以下绝不使用确定语气（「倾向于」+ 明示统计性质）", /基于 5 条视觉记忆的统计/.test(r.summary), r.summary);
}

// ============================ Case 1: 正常创作请求 =============================
console.log("Case 1 — 正常创作请求 → references > 0 + evidence exists");
{
  const r = await runAssistant({ task: "creative_support", query: "我要设计一个荒原夜晚的孤独镜头" });
  check("case1", "references.length > 0", r.ok && r.references.length > 0, `got ${(r.references || []).length}`);
  check("case1", "每条参考带 evidence（reason + matchedFields）", (r.references || []).every((x) => x.reason.length > 0 && x.matchedFields.length > 0));
  check("case1", "direction 来自个人画像（非 AI 发明）", r.direction.space.length > 0 && r.basedOn.sampleSize === 5, JSON.stringify(r.direction.space));
  check("case1", "长尾词诚实（荒原→空旷映射，夜晚→氛围 token）", (r.sceneQuery.atmosphere || []).includes("夜晚"), JSON.stringify(r.sceneQuery));
}

// ============================ Case 2: 不存在的视觉需求 =========================
console.log("Case 2 — 「找粉色未来城市」→ honest no match，禁止编造");
{
  const r = await runAssistant({ task: "find_reference", query: "找粉色未来城市" });
  check("case2", "诚实无法提取（粉色/未来不在 schema token 空间）", r.ok === false && /无法.*提取/.test(r.message || ""), r.message);
  check("case2", "零编造结果", Array.isArray(r.results) && r.results.length === 0);
  check("case2", "unmapped 明示（粉色/未来/城市在列）", (r.unmapped || []).join().includes("粉色") && (r.unmapped || []).join().includes("未来"), JSON.stringify(r.unmapped));
  const r2 = await runAssistant({ task: "creative_support", query: "找粉色未来城市" });
  const joined = JSON.stringify([r, r2]);
  check("case2", "全链路零编造资产引用", !["https://fake", 'image: "data:', "w-fake"].some((f) => joined.includes(f)));
}

await rm(store, { recursive: true, force: true }).catch(() => {});

console.log(`\n==== ${pass} PASS / ${fail} FAIL ====`);
await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify({ total: pass + fail, pass, fail, results }, null, 2) + "\n", "utf8");
console.log(`→ ${OUT}`);
process.exit(fail > 0 ? 1 : 0);
