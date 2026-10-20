// p415-semantics.test.mjs — P4.15.2/P4.15.3 语义召回路径
//
// 钉住六件事：
//   · 画像只能来自已核实的模型输出（独立单图分析 / 真实比较缓存），Mock 一律不算
//   · 证据分三级：A 独立单图分析、B 关系描述、C 从差异文本反推；
//     B/C 不得冒充 A，C 不得作为候选证据复用
//   · 通用词（前景/建筑/灰）重合不算命中；强词不能只来自构图
//   · 互相矛盾的证据（室内 vs 室外、无人物 vs 两人）直接否决
//   · 固定的历史事实（含「舞蹈课曾接受后被移出」）必须随仓库保存
//   · P4.15.3 的冻结比较集必须在调用前落盘、且角色标注覆盖全部候选

import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

const st = new Map();
globalThis.window = {
  localStorage: {
    getItem: (k) => (st.has(k) ? st.get(k) : null),
    setItem: (k, v) => st.set(k, String(v)),
    removeItem: (k) => st.delete(k),
  },
  location: { origin: "http://127.0.0.1", hash: "" },
};
globalThis.localStorage = globalThis.window.localStorage;

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log(`PASS ${name}`); }
  catch (e) { fail++; console.log(`FAIL ${name}\n     ${e.message}`); }
}

const sem = await imp("experiment/p415/semantics.mjs");

const CACHE = path.join(ROOT, ".rc1-audit/p415/cache");
const STATE = path.join(ROOT, ".rc1-audit/p415/preflight-state.json");
const FIXTURE = path.join(ROOT, "experiment/p415/fixtures/pinned-cases.json");
const ANALYSES = path.join(ROOT, ".rc1-audit/p415/v2-analyses");
const FROZEN = path.join(ROOT, "experiment/p415/fixtures/frozen-sets-p4153.json");

const table = sem.buildSemanticTable({ cacheDir: CACHE, statePath: STATE, fixturesPath: FIXTURE, analysesDir: ANALYSES });
const tableNoAnalyses = sem.buildSemanticTable({ cacheDir: CACHE, statePath: STATE, fixturesPath: FIXTURE });

const mk = (t) => ({ entryId: "x", kind: "single-image-analysis", evidenceTier: "A", tierNote: null, tokens: { composition: [], subject: [], space: [], colorLight: [], ...t } });
const discover = (q, c) => sem.semanticDiscover(mk(q), new Map(Object.entries(c).map(([k, v]) => [k, mk(v)])));

console.log("=== 1. 画像来源与证据等级 ===");
await check("画像表非空，且记录三类来源统计", () => {
  assert.ok(table.profiles.size > 0, "没有任何画像");
  assert.ok(table.stats.comparisonEntries >= 1, "没有真实比较条目");
  assert.ok(table.stats.independentAnalyses >= 3, `独立单图分析只有 ${table.stats.independentAnalyses} 条`);
});

await check("三张查询图有 A 级独立画像，含构图与色彩", () => {
  for (const id of ["paris-rainy-day", "fan-kuan-travelers", "guo-xi-early-spring"]) {
    const p = table.profiles.get(id);
    assert.ok(p, `${id} 缺少画像`);
    assert.equal(p.evidenceTier, "A", `${id} 不是 A 级`);
    assert.equal(p.kind, "single-image-analysis");
    assert.ok(p.composition.skeleton || p.composition.weight, `${id} 没有构图`);
    assert.ok(p.colorLight.dominant || p.colorLight.quality, `${id} 没有色彩/光线`);
  }
});

await check("不提供独立分析时，查询画像退回反推并标为 C", () => {
  const p = tableNoAnalyses.profiles.get("paris-rainy-day");
  assert.ok(p, "没有反推画像");
  assert.equal(p.evidenceTier, "C");
  assert.equal(p.kind, "derived-query");
  assert.ok(p.tierNote, "C 级必须说明局限");
});

await check("A 级不被 B 或 C 覆盖", () => {
  for (const id of ["american-gothic", "paris-rainy-day", "fan-kuan-travelers"]) {
    const p = table.profiles.get(id);
    assert.equal(p.evidenceTier, "A", `${id} 被降级成 ${p.evidenceTier}`);
  }
});

await check("Mock 缓存不计入画像", () => {
  const p = table.profiles.get("utamaro-three-beauties");
  if (p) assert.notEqual(p.source?.model, "mock", "画像来自 mock");
});

console.log("\n=== 2. 语义发现的门槛 ===");
await check("只有通用词重合不算命中（前景/建筑/灰）", () => {
  const r = discover(
    { composition: ["前景", "中景"], space: ["建筑"], colorLight: ["灰"] },
    { c1: { composition: ["前景", "中景"], space: ["建筑"], colorLight: ["灰"] } },
  );
  assert.equal(r.hits.length, 0, "弱词重合被当成命中");
});

await check("强词只来自构图时不命中", () => {
  const r = discover(
    { composition: ["竖向", "居中"], space: ["建筑"] },
    { c1: { composition: ["竖向", "居中"], space: ["建筑"] } },
  );
  assert.equal(r.hits.length, 0, "「竖向+居中」不该单独构成命中");
});

await check("构图以外的强证据成立时命中，并给出证据", () => {
  const r = discover(
    { composition: ["竖向", "居中"], subject: ["两人", "并肩"], space: ["街道"], colorLight: ["漫射"] },
    { c1: { composition: ["竖向", "居中"], subject: ["两人", "并肩"], space: ["街道"], colorLight: ["漫射"] } },
  );
  assert.equal(r.hits.length, 1, "应当命中");
  assert.ok(r.hits[0].matchedDimensions.length >= 2);
  assert.ok(r.hits[0].strongTokens.length >= 2);
  assert.ok(r.hits[0].evidence.length >= 2);
});

await check("室内/室外 矛盾证据直接否决", () => {
  const r = discover(
    { space: ["室内", "街道"], colorLight: ["漫射", "冷灰"] },
    { c1: { space: ["室外"], colorLight: ["漫射", "冷灰"] } },
  );
  assert.equal(r.hits.length, 0, "室内与室外被判成同一场景");
});

await check("无人物 与 两人 矛盾证据直接否决", () => {
  const r = discover(
    { composition: ["竖向", "居中"], subject: ["无人物"], colorLight: ["单色", "漫射"] },
    { c1: { composition: ["竖向", "居中"], subject: ["两人", "并肩"], colorLight: ["单色", "漫射"] } },
  );
  assert.equal(r.hits.length, 0, "人物数量矛盾未否决");
});

await check("C 级候选不作为候选证据复用", () => {
  const q = mk({ composition: ["竖向", "居中"], subject: ["两人", "并肩"], space: ["街道"], colorLight: ["漫射"] });
  const c = mk({ composition: ["竖向", "居中"], subject: ["两人", "并肩"], space: ["街道"], colorLight: ["漫射"] });
  c.evidenceTier = "C"; c.entryId = "derived-one";
  const r = sem.semanticDiscover(q, new Map([["derived-one", c]]));
  assert.equal(r.hits.length, 0, "C 级被当成候选证据");
  assert.equal(r.skippedTierC, 1, "没有记录跳过的 C 级数量");
});

await check("B 级命中必须带候选局限说明", () => {
  const q = mk({ composition: ["竖向", "居中"], subject: ["两人", "并肩"], space: ["街道"], colorLight: ["漫射"] });
  const c = mk({ composition: ["竖向", "居中"], subject: ["两人", "并肩"], space: ["街道"], colorLight: ["漫射"] });
  c.evidenceTier = "B"; c.tierNote = "来自关系描述";
  const r = sem.semanticDiscover(q, new Map([["b-one", c]]));
  assert.equal(r.hits.length, 1);
  assert.equal(r.hits[0].candidateEvidenceTier, "B");
  assert.equal(r.hits[0].candidateAnalysisUnavailable, true);
  assert.ok(r.hits[0].limitation, "B 级缺少局限说明");
});

await check("查询没有画像时明确跳过并说明原因", () => {
  const r = sem.semanticDiscover(null, new Map());
  assert.equal(r.hits.length, 0);
  assert.match(r.skipped, /没有语义画像/);
});

console.log("\n=== 3. 固定历史事实 ===");
await check("夹具随仓库存在，且记录「舞蹈课曾接受后被移出」", () => {
  assert.ok(fs.existsSync(FIXTURE), "缺少 pinned-cases.json");
  const fx = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  const accepted = fx.facts.find((f) => /曾接受《舞蹈课》/.test(f.fact));
  assert.ok(accepted, "缺少「曾接受」事实");
  assert.equal(accepted.detail.relation, "partial");
  assert.ok(accepted.detail.compositionEvidence.includes("芭蕾舞者"));
  const moved = fx.facts.find((f) => /移出 top8/.test(f.fact));
  assert.ok(moved, "缺少「被移出」事实");
  assert.equal(moved.detail.danceClassRecallRanks.vector, 3);
  assert.ok(!moved.detail.top8After.includes("dance-class"));
});

await check("夹具固定四组查询的前后排序", () => {
  const fx = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  for (const q of ["american-gothic", "paris-rainy-day", "fan-kuan-travelers", "guo-xi-early-spring"]) {
    const r = fx.beforeAfter[q];
    assert.ok(r, `缺少 ${q}`);
    assert.ok(r.before.length === 5 && r.after.length === 8, `${q} 长度不符`);
  }
});

await check("夹具记录「向量碰撞」更正", () => {
  const fx = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  const f = fx.facts.find((x) => /向量碰撞/.test(x.fact));
  assert.ok(f);
  assert.ok(f.detail.cosines["fan-kuan--shitao"] < 0.5, "余弦不该是这个值");
});

console.log("\n=== 4. P4.15.3 冻结比较集 ===");
await check("冻结集随仓库存在，四组各 5–6 张候选", () => {
  assert.ok(fs.existsSync(FROZEN), "缺少 frozen-sets-p4153.json");
  const fx = JSON.parse(fs.readFileSync(FROZEN, "utf8"));
  assert.equal(fx.cases.length, 4);
  for (const c of fx.cases) {
    assert.ok(c.candidates.length >= 5 && c.candidates.length <= 6, `${c.id} 候选数 ${c.candidates.length}`);
  }
});

await check("每个候选都有角色标注（假设/旧序/跨传统）", () => {
  const fx = JSON.parse(fs.readFileSync(FROZEN, "utf8"));
  for (const c of fx.cases) {
    for (const id of c.candidates) {
      assert.ok(c.roles?.[id], `${c.id} 的 ${id} 没有角色说明`);
    }
    const hasOld = Object.values(c.roles).some((t) => /旧系统靠前/.test(t));
    assert.ok(hasOld, `${c.id} 缺少「旧系统靠前」的对照候选`);
  }
});

console.log(`\n=== P4.15.2/15.3 语义召回: ${pass}/${pass + fail} PASS, ${fail} FAIL ===`);
if (fail > 0) process.exitCode = 1;
