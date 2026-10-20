// p415-recall.test.mjs — P4.15.1 多路召回 / 作用域分级 / 比较集选择
//
// 钉的是可被推翻的约束：
//   · 每条候选必须能说出「哪几路召回的、第几名」，不许只给一个黑箱分数
//   · 送进模型比较的集合不能全来自同一路（否则扩召回等于换样本）
//   · 只有色彩光线证据的，不能报成整体/构图参考
//   · 媒介过滤在召回层就生效（动画档不能出绘画）
//   · 可观察特征表缺失时自动降级，不崩

import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

const store = new Map();
globalThis.window = {
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
  location: { origin: "http://127.0.0.1", hash: "" },
};
globalThis.localStorage = globalThis.window.localStorage;

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log(`PASS ${name}`); }
  catch (e) { fail++; console.log(`FAIL ${name}\n     ${e.message}`); }
}

const rm = await imp("experiment/p415/recall-multipath.mjs");
const vsFile = await imp("experiment/p415/vision-search.mjs");
const vs = await imp("src/services/features/visualSearch.js");

const LIB = vs.library();
const byId = new Map(LIB.map((e) => [e.id, e]));
const AG = byId.get("american-gothic");
const PARIS = byId.get("paris-rainy-day");

console.log("=== 1. 可观察特征表 ===");
await check("特征表存在且条目数 ≥ 47", () => {
  const p = path.join(ROOT, "experiment/p415/observables.json");
  assert.ok(fs.existsSync(p), "缺少 observables.json");
  const d = JSON.parse(fs.readFileSync(p, "utf8"));
  assert.ok(Object.keys(d.entries).length >= 47, `只有 ${Object.keys(d.entries).length} 条`);
});

await check("特征字段齐全且有物理含义", () => {
  const d = JSON.parse(fs.readFileSync(path.join(ROOT, "experiment/p415/observables.json"), "utf8"));
  const e = d.entries["american-gothic"];
  for (const k of ["aspect", "meanLum", "contrast", "meanSat", "warmthValue", "lumTop", "lumBottom", "edgeDensity", "asymmetry"]) {
    assert.equal(typeof e[k], "number", `缺 ${k}`);
  }
  assert.ok(["warm", "cool", "neutral"].includes(e.warmth), `warmth 取值异常：${e.warmth}`);
  // AG 画面：上方浅色房屋/天空，下方深色衣物 → 上亮下暗
  assert.ok(e.lumTop > e.lumBottom, `AG 上/下明度异常：${e.lumTop} / ${e.lumBottom}`);
});

console.log("\n=== 2. 多路召回与来源 ===");
await check("三路都出候选，每条带来源与名次", () => {
  const r = rm.multipathRecall({ queryEntry: AG, media: "all", limit: 12, root: ROOT, perPath: 10 });
  assert.ok(r.candidates.length > 0);
  assert.ok(r.paths.vector > 0 && r.paths.structure > 0 && r.paths.observable > 0,
    `路径计数 ${JSON.stringify(r.paths)}`);
  for (const c of r.candidates) {
    assert.ok(Array.isArray(c.sources) && c.sources.length >= 1, `${c.id} 没有来源`);
    for (const s of c.sources) {
      assert.ok(["vector", "structure", "observable"].includes(s.path), `未知路径 ${s.path}`);
      assert.ok(Number.isInteger(s.rank) && s.rank >= 1, `名次异常 ${s.rank}`);
      assert.ok(typeof s.reason === "string" && s.reason.length > 0, `${c.id} 的来源缺理由`);
    }
  }
});

await check("融合分单调不增", () => {
  const r = rm.multipathRecall({ queryEntry: AG, media: "all", limit: 12, root: ROOT, perPath: 10 });
  for (let i = 1; i < r.candidates.length; i++) {
    assert.ok(r.candidates[i - 1].fused >= r.candidates[i].fused, `第 ${i} 位融合分反了`);
  }
});

await check("多路命中的候选被标记", () => {
  const r = rm.multipathRecall({ queryEntry: AG, media: "all", limit: 12, root: ROOT, perPath: 10 });
  const multi = r.candidates.filter((c) => c.multiPath);
  assert.ok(multi.length > 0, "没有任何候选被两路以上命中，融合等于单路");
});

console.log("\n=== 3. 比较集选择：去除强制每路取一的政策 ===");
await check("主集按融合序取满 judgeCount", () => {
  const r = rm.multipathRecall({ queryEntry: PARIS, media: "all", limit: 12, root: ROOT, perPath: 10 });
  const picked = rm.selectForComparison(r.candidates, 3);
  assert.equal(picked.length, 3);
  assert.deepEqual(picked.map((c) => c.id), r.candidates.slice(0, 3).map((c) => c.id), "主集必须严格按融合序");
});

await check("语义发现不抢主集名额，只在剩余名额内补入且带标记", () => {
  const r = rm.multipathRecall({ queryEntry: PARIS, media: "all", limit: 12, root: ROOT, perPath: 10 });
  const fake = { id: "__semantic_only__", sources: [], semanticDiscovery: { matchedDimensions: ["composition", "space"] } };
  const picked = rm.selectForComparison(r.candidates, 3, [fake]);
  assert.equal(picked.length, 4, "补入后应为 4");
  assert.deepEqual(picked.slice(0, 3).map((c) => c.id), r.candidates.slice(0, 3).map((c) => c.id), "主集不能被挤动");
  assert.equal(picked[3].id, "__semantic_only__");
});

await check("补入上限 6，judgeCount 再大也不超", () => {
  const r = rm.multipathRecall({ queryEntry: PARIS, media: "all", limit: 12, root: ROOT, perPath: 10 });
  const extras = Array.from({ length: 8 }, (_, i) => ({ id: `x${i}`, sources: [], semanticDiscovery: { matchedDimensions: ["space"] } }));
  const picked = rm.selectForComparison(r.candidates, 5, extras);
  assert.ok(picked.length <= 6, `实得 ${picked.length}`);
});

console.log("\n=== 4. 作用域分级：只有光线不能说构图 ===");
const j = (o) => ({ index: 0, verdict: "partial", verdictFromModel: "partial", downgraded: false, downgradeNote: null, similarPoints: [], majorDifferences: [], unknown: [], ...o });

await check("只有色彩光线证据 → specific，并带限制说明", () => {
  const s = vsFile.referenceScope(j({ colorLightEvidence: "低饱和冷调" }));
  assert.equal(s.scope, "specific");
  assert.match(s.limitation, /不构成构图/);
});

await check("构图 + 主体证据 → overall", () => {
  const s = vsFile.referenceScope(j({ compositionEvidence: "竖轴", subjectRelationEvidence: "双人并立" }));
  assert.equal(s.scope, "overall");
  assert.equal(s.limitation, null);
});

await check("只有构图、没有主体 → 不升级为 overall", () => {
  const s = vsFile.referenceScope(j({ compositionEvidence: "竖轴" }));
  assert.equal(s.scope, "partial");
  assert.match(s.limitation, /部分维度/);
});

await check("没有任何证据 → none", () => {
  assert.equal(vsFile.referenceScope(j({})).scope, "none");
});

await check("产品字段不会把 specific 说成构图相关", () => {
  const p = vsFile.toProductJudgment(j({ colorLightEvidence: "低饱和冷调", similarPoints: ["[mock] 偏冷"] }));
  assert.equal(p.referenceScope, "specific");
  assert.equal(p.compositionEvidence, null, "无构图证据时不得凭相似点文本补出构图证据");
});

console.log("\n=== 5. 媒介硬过滤 ===");
await check("动画档在召回层就是空", () => {
  const r = rm.multipathRecall({ queryEntry: AG, media: "animation", limit: 12, root: ROOT, perPath: 10 });
  assert.equal(r.candidates.length, 0, `动画档出了 ${r.candidates.length} 条`);
  assert.ok(r.note);
});

console.log("\n=== 6. 降级 ===");
await check("特征表找不到时 observable 路被跳过而不是崩", () => {
  const r = rm.multipathRecall({ queryEntry: AG, media: "all", limit: 6, root: path.join(ROOT, "__none__"), perPath: 6 });
  assert.ok(Array.isArray(r.candidates));
  assert.ok(r.paths.skipped.some((s) => s.path === "observable"), "应跳过 observable 路");
});

console.log(`\n=== P4.15.1 召回与分级: ${pass}/${pass + fail} PASS, ${fail} FAIL ===`);
if (fail > 0) process.exitCode = 1;
