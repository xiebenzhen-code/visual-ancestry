// P5.6 STEP 5 — assistant-test.mjs · Personal Visual Assistant 薄层 QA.
// Zero provider, zero LLM: the assistant is a composition layer over frozen
// profile/retrieval/repository — all cases run real product code on TEMP stores.
//
// Store-binding (P5.4 lesson): memoryRepository reads MEMORY_STORE_DIR at first
// import. Cases 1–4 run on an empty temp store → seed → assertions; Case 5 then
// deletes EVERY memory through the product's own deleteMemory() API (the spec's
// literal「删除全部 memory」) and re-runs the anti-hallucination assertions
// in-process (sandbox forbids child spawn; a `?query` re-import does NOT
// re-bind because relative imports of dependencies drop the query string).
//
// Cases:
//   1 空库 understand_taste → 诚实「样本不足」，不编造倾向
//   2 understand_taste 引用真实 profile（evidence 与真实计数一致；禁词零出现）
//   3 find_reference 返回真实 memory + 真实 reason（NL 映射 + 个人倾向补全）
//   4 creative_support 输出引用 profile + memory（direction 来自统计）
//   5 防幻觉（删空池）：没有足够参考 → 零编造、零强行推荐
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const SRC = (...p) => pathToFileURL(path.join(ROOT, "src", ...p)).href;
const OUT = path.join(ROOT, "work", "p5.6-assistant", "assistant-test-results.json");

const results = [];
let pass = 0, fail = 0;
const check = (caseName, desc, cond, detail) => {
  if (cond) { pass++; results.push({ caseName, desc, pass: true }); console.log(`  ✓ ${desc}`); }
  else { fail++; results.push({ caseName, desc, pass: false, detail: detail || "" }); console.log(`  ✗ ${desc}${detail ? " · " + detail : ""}`); }
};
const FORBIDDEN = ["审美等级", "人格", "比别人", "高级", "你的风格是", "评分"];

const storeA = await mkdtemp(path.join(os.tmpdir(), "p56-assist-a-"));
const storeB = await mkdtemp(path.join(os.tmpdir(), "p56-assist-b-"));
process.env.MEMORY_STORE_DIR = storeA;

function mem(id, intent) {
  return {
    id, status: "success",
    metadata: { title: `t-${id}`, origin: "artwork-reference" },
    visualIntent: { source: "vision", ...intent },
    userData: {},
  };
}
const deepLonely = (id) => mem(id, {
  spatialDepth: "deep", environmentDominance: "high", negativeSpace: "high",
  saturation: "low", humanRelation: "isolated", socialDistance: "high",
  colorTemperature: "cool", contrast: "high", atmosphere: ["寂静"],
});

// ============================ Case 1: 空库 taste ==============================
console.log("Case 1 — 空库：理解我的审美 → 诚实样本不足");
{
  const { runAssistant } = await import(SRC("services", "memory", "visualAssistant.js"));
  const r = await runAssistant({ task: "understand_taste" });
  check("case1", "ok=false（不假装能总结）", r.ok === false);
  check("case1", "sampleSize = 0 且如实携带", r.sampleSize === 0);
  check("case1", "summary 明示样本不足", /没有足够的视觉记忆|样本不足/.test(r.summary || ""), r.summary);
  check("case1", "confidence = empty（来自冻结 getConfidence）", r.confidence && r.confidence.level === "empty", JSON.stringify(r.confidence));
  check("case1", "evidence 为空（不凭空生成倾向）", Array.isArray(r.evidence) && r.evidence.length === 0);
}

// ============================ seed store A ====================================
console.log("（注入 6 条真实结构资产：5 条深空间孤独 + 1 条热闹高饱和）");
{
  const { addMemory } = await import(SRC("services", "memory", "memoryRepository.js"));
  for (const id of ["a1", "a2", "a3", "a4", "a5"]) await addMemory(deepLonely(id));
  await addMemory(mem("a6", {
    spatialDepth: "shallow", saturation: "high", humanRelation: "crowd",
    colorTemperature: "warm", environmentDominance: "low", contrast: "low",
  }));
}

const { runAssistant } = await import(SRC("services", "memory", "visualAssistant.js"));

// ============================ Case 2: taste 引用真实 profile ==================
console.log("Case 2 — 总结我的视觉偏好 → 引用真实 profile");
{
  const r = await runAssistant({ task: "understand_taste" });
  check("case2", "ok=true 且 sampleSize=6", r.ok === true && r.sampleSize === 6, `got ${r.sampleSize}`);
  check("case2", "confidence 绑定样本量（based on 6）", r.confidence.level === "observation" && /6/.test(r.confidence.basis), JSON.stringify(r.confidence));
  check("case2", "summary 来自真实统计（深空间 5/6 ≥55% 被点名）", /深空间/.test(r.summary), r.summary);
  check("case2", "evidence 携带真实计数（低饱和 5/6）", r.evidence.some((e) => /低饱和/.test(e) && /5\/6/.test(e)), r.evidence.join(" | "));
  const joined = JSON.stringify(r);
  const leaked = FORBIDDEN.filter((f) => joined.includes(f));
  check("case2", `禁词零出现（审美等级/人格/比别人…）→ ${leaked.length ? leaked.join(",") : "无"}`, leaked.length === 0);
  check("case2", "a6 的少数派特征不被声张（高饱和 1/6 <40% 无主张）", !r.evidence.some((e) => /高饱和/.test(e)));
}

// ============================ Case 3: find_reference ==========================
console.log("Case 3 — 找孤独空间 → 真实 memory + 真实 reason");
{
  const r = await runAssistant({ task: "find_reference", query: "找一些孤独空间感觉的参考" });
  check("case3", "NL 映射到真实 schema（humanRelation=isolated）", r.ok && r.visualQuery.humanRelation === "isolated", JSON.stringify(r.visualQuery));
  check("case3", "「空间」等未映射词诚实收集", Array.isArray(r.unmapped));
  check("case3", "返回 5 条真实 memory（注入池子集，a6 排除）", r.results.length === 5 && r.results.every((x) => /^t-a[1-5]$/.test(x.title)), r.results.map((x) => x.title).join(",") || "(empty)");
  check("case3", "每条带真实 reason 与 matchedFields", r.results.length > 0 && r.results.every((x) => x.reason.length > 0 && x.matchedFields.includes("humanRelation")));
  check("case3", "补全透明（enrichedQuery 如实展示或无需补全）", r.results.length === 0 ? !!r.note : (r.enrichedQuery ? /补全/.test(r.note || "") : true), JSON.stringify(r.enrichedQuery));
  const bad = await runAssistant({ task: "find_reference", query: "随便看看" });
  check("case3", "无视觉语言可映射 → 诚实无法提取（不瞎猜）", bad.ok === false && /无法.*提取/.test(bad.message), bad.message);
}

// ============================ Case 4: creative_support ========================
console.log("Case 4 — 设计夜晚工业场景 → 引用 profile + memory");
{
  const r = await runAssistant({ task: "creative_support", query: "我要设计一个夜晚工业城市场景" });
  check("case4", "basedOn 携带真实样本量与 confidence", r.basedOn.sampleSize === 6 && r.basedOn.confidence.level === "observation", JSON.stringify(r.basedOn));
  check("case4", "direction.space 来自个人画像统计（深空间 83%）", r.direction.space.some((s) => /深空间/.test(s) && /83%/.test(s)), r.direction.space.join("|"));
  check("case4", "references 是真实历史收藏（非编造）", r.references.length > 0 && r.references.every((x) => /^t-a/.test(x.title) && x.reason.length > 0), r.references.map((x) => x.title).join(","));
  check("case4", "「工业」「夜晚」处理诚实（夜晚→氛围 token，工业→unmapped）", /工业/.test((r.unmapped || []).join()) === true && r.sceneQuery.atmosphere && r.sceneQuery.atmosphere.includes("夜晚"), JSON.stringify({ scene: r.sceneQuery, unmapped: r.unmapped }));
  const joined = JSON.stringify(r);
  const leaked = FORBIDDEN.filter((f) => joined.includes(f));
  check("case4", `禁词零出现 → ${leaked.length ? leaked.join(",") : "无"}`, leaked.length === 0);
  check("case4", "明示「不是 AI 创作，决策在用户」", /不是 AI 创作/.test(r.note || ""));
}

// ============================ Case 5: 防幻觉（删空池）=========================
// Spec 原意：「删除全部 memory → 找我的类似作品 → 必须没有足够参考」。
// 用产品自身的 deleteMemory() 逐条清空（同进程；沙箱禁子进程 spawn，
// 且 `?query` 重导入不会重绑依赖模块的 store——deleteMemory 才是产品真实路径）。
console.log("Case 5 — 防幻觉：删除全部 memory → 禁止编造");
{
  const { deleteMemory, listMemories } = await import(SRC("services", "memory", "memoryRepository.js"));
  for (const m of await listMemories()) await deleteMemory(m.id);
  const left = await listMemories();
  check("case5", "池已通过产品 API 删空", left.filter((m) => m.status === "success").length === 0, `left ${left.length}`);

  const r1 = await runAssistant({ task: "find_reference", query: "找我的类似作品" });
  check("case5", "无法映射 → 诚实无法提取（无编造结果）", r1.ok === false && r1.results.length === 0, r1.message);
  const r2 = await runAssistant({ task: "find_reference", query: "找孤独空间的参考" });
  check("case5", "空库检索 → 0 结果 + 如实说明不强行推荐", r2.ok === true && r2.results.length === 0 && /没有.*匹配|不强行推荐/.test(r2.note || ""), r2.note);
  const r3 = await runAssistant({ task: "creative_support", query: "设计一个孤独场景" });
  check("case5", "空库创作辅助 → 明确拒绝（个人记忆为空，不编造方向）", r3.ok === false && r3.direction === null && /没有足够|为空|不会编造/.test(r3.message || ""), r3.message);
  const r4 = await runAssistant({ task: "understand_taste" });
  check("case5", "空库审美总结 → 回到诚实「样本不足」", r4.ok === false && r4.sampleSize === 0);
  const joined = JSON.stringify([r1, r2, r3, r4]);
  check("case5", "零编造资产引用（无任何已删除池的内容）", !["t-a1", "t-a6", "https://fake", 'image: "data:'].some((f) => joined.includes(f)));
}

await rm(storeA, { recursive: true, force: true }).catch(() => {});
await rm(storeB, { recursive: true, force: true }).catch(() => {});

console.log(`\n==== ${pass} PASS / ${fail} FAIL ====`);
await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify({ total: pass + fail, pass, fail, results }, null, 2) + "\n", "utf8");
console.log(`→ ${OUT}`);
process.exit(fail > 0 ? 1 : 0);
