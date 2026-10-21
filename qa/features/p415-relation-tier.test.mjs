// p415-relation-tier.test.mjs — P4.15.4 视觉关联档位与证据复用
//
// 钉的六件事（都可被推翻）：
//   1. 相似点必须经得起差异核对：被「单人 vs 双人」「室内 vs 室外」这类对照推翻的维度，不算证据
//   2. 只剩色彩/光线 → specific；构图 + 主体/空间 → 才够 high
//   3. 裁决只降不升：模型说 unrelated 就永不升级
//   4. 真实缓存上的不变量：specific 的正面维度只能是 colorLight；unrelated 必须没有正面维度
//   5. 语义旁路只允许 A 级跨查询；B 级只在原始查询-候选对；C 级不参与
//   6. 输出保留人工复核入口（needsReview / 证据留痕），模型输出不当真值
//
// 注意：本文件**不**断言某件作品应该是什么档位。断言的是通用规则与聚合不变量。

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

const rt = await imp("server/vision/relationTier.js");
const vsFile = await imp("experiment/p415/vision-search.mjs");
const sem = await imp("experiment/p415/semantics.mjs");

const J = (o) => ({
  index: 0, verdict: "partial", verdictFromModel: "partial", downgraded: false, downgradeNote: null,
  similarPoints: [], majorDifferences: [], unknown: [], ...o,
});

console.log("=== 1. 档位规则（合成样本） ===");
await check("「单人 vs 双人」推翻主体维度，主体不得计入正面证据", () => {
  const r = rt.adjudicate("partial", J({
    similarPoints: ["两人并排站立，正面朝向观者", "背景为浅色墙面"],
    majorDifferences: ["候选为单人侧面坐姿，查询为双人正面并排站立"],
  }));
  assert.ok(!r.positiveDims.includes("subject"), `主体未被推翻：${r.positiveDims.join("/")}`);
  assert.ok(!r.positiveDims.includes("composition"), "主体数量不符时构图也不该算数");
  assert.notEqual(r.relation, "high");
});

await check("主体与场景同时被推翻 → 只剩色彩时落到 specific", () => {
  const r = rt.adjudicate("partial", J({
    similarPoints: ["两人并排站立，正面朝向观者", "背景为浅色墙面", "整体低饱和冷调"],
    majorDifferences: ["候选为单人侧面坐姿", "候选背景为室内墙面与窗，查询背景为室外建筑与天空"],
  }));
  assert.ok(["specific", "unrelated"].includes(r.relation), `实得 ${r.relation}`);
});

await check("只剩色彩/光线 → specific", () => {
  const r = rt.adjudicate("partial", J({
    similarPoints: ["整体为低饱和冷调"],
    majorDifferences: ["候选室内单人，查询为室外双人", "候选背景为墙面，查询为建筑立面与天空"],
  }));
  assert.equal(r.relation, "specific");
});

await check("构图 + 空间成立且模型给 high → high", () => {
  const r = rt.adjudicate("high", J({
    similarPoints: ["竖幅立轴构图，主峰居中偏上", "山体层叠堆高，前景与远景之间留出云雾过渡"],
    majorDifferences: ["候选山体被雾分割成多组峰峦，查询为一整块巨峰"],
  }));
  assert.equal(r.relation, "high");
});

await check("只有构图成立、主体与空间都不成立 → 最多 partial", () => {
  const r = rt.adjudicate("high", J({
    similarPoints: ["竖幅画面"],
    majorDifferences: ["候选为室内单人，查询为室外双人"],
  }));
  assert.notEqual(r.relation, "high");
});

await check("模型说 unrelated 永不升级", () => {
  const r = rt.adjudicate("unrelated", J({
    similarPoints: ["竖幅立轴构图，主峰居中偏上", "前景坡石与远景雾气过渡"],
    majorDifferences: ["题材不同"],
  }));
  assert.equal(r.relation, "unrelated");
});

await check("同一句里出现室内 vs 室外 → 空间维度被推翻", () => {
  const f = rt.falsify(["室内场景，背景为墙面"], ["候选背景为室内墙面与窗，查询背景为室外建筑与天空"]);
  assert.ok(f.space, "空间维度没有被推翻");
});

await check("同一句里出现平面化 vs 写实空间 → 空间维度被推翻", () => {
  const f = rt.falsify(["背景为平面化处理，没有纵深"], ["候选为浅色平面，查询为写实建筑与天空"]);
  assert.ok(f.space, "空间维度没有被推翻");
});

await check("人数相同的两人：关系冲突保留并置布局，但不许升到 high", () => {
  const r = rt.adjudicate("partial", J({
    similarPoints: ["双人位于画面中央，占据主要面积"],
    majorDifferences: ["候选为双人拥抱、身体交叠，查询为双人并排站立、身体分离"],
  }));
  assert.ok(r.positiveDims.includes("subject"), "并置布局被错误清零");
  assert.equal(r.relation, "partial");
});

await check("人数冲突（单人 vs 双人）才整维清零", () => {
  const r = rt.adjudicate("partial", J({
    similarPoints: ["双人位于画面中央，占据主要面积"],
    majorDifferences: ["候选为单人侧面坐姿，查询为双人并排站立"],
  }));
  assert.ok(!r.positiveDims.includes("subject"), "人数不符仍保留主体维度");
});

await check("细部差别（骨架更对称）不推翻整维", () => {
  const f = rt.falsify(["竖幅立轴构图，主峰居中偏上"], ["候选是单一主峰垂直居中，骨架更对称"]);
  assert.equal(Object.keys(f).length, 0, `不该证伪：${JSON.stringify(f)}`);
});

console.log("\n=== 2. 真实缓存上的不变量（21 条已付费判定） ===");
const CASES = ["paris-rainy-day", "fan-kuan-travelers", "guo-xi-early-spring", "american-gothic"];
const judged = [];
for (const id of CASES) {
  const d = JSON.parse(fs.readFileSync(path.join(ROOT, `.rc1-audit/p415/cases/${id}.json`), "utf8"));
  for (const j of d.judgments) {
    judged.push({ q: id, c: d.candidateIds[j.index], j, r: rt.adjudicate(j.verdict, j) });
  }
}

await check("21 条真实判定全部可裁决", () => {
  assert.equal(judged.length, 21);
});

await check("裁决永不强于模型档位", () => {
  const RANK = { high: 3, partial: 2, specific: 1, unrelated: 0 };
  for (const x of judged) {
    assert.ok(RANK[x.r.relation] <= RANK[x.j.verdict], `${x.c} 被升级：${x.j.verdict} → ${x.r.relation}`);
  }
});

await check("specific 的正面维度只能是色彩光线", () => {
  for (const x of judged) {
    if (x.r.relation !== "specific") continue;
    const bad = x.r.positiveDims.filter((d) => d !== "colorLight");
    assert.equal(bad.length, 0, `${x.c} 以 ${bad.join("/")} 进了 specific`);
  }
});

await check("被我们降到 unrelated 的，必须没有站得住的维度", () => {
  for (const x of judged) {
    if (x.r.relation !== "unrelated") continue;
    if (x.j.verdict === "unrelated") continue;   // 模型自己判的无关，保留维度信息供复核
    assert.equal(x.r.positiveDims.length, 0, `${x.c} 仍有维度：${x.r.positiveDims.join("/")}`);
  }
});

await check("模型主动判 unrelated 的候选，维度信息仍可留档但档位不回升", () => {
  for (const x of judged) {
    if (x.j.verdict !== "unrelated") continue;
    assert.equal(x.r.relation, "unrelated", `${x.c} 被升级`);
  }
});

await check("high 必须同时有构图与主体/空间", () => {
  for (const x of judged) {
    if (x.r.relation !== "high") continue;
    assert.ok(x.r.positiveDims.includes("composition"), `${x.c} 缺构图`);
    assert.ok(x.r.positiveDims.includes("subject") || x.r.positiveDims.includes("space"), `${x.c} 缺主体/空间`);
  }
});

await check("聚合：high 不超过 2 条，且至少 4 条落到 specific/unrelated", () => {
  const counts = judged.reduce((a, x) => { a[x.r.relation] = (a[x.r.relation] || 0) + 1; return a; }, {});
  assert.ok((counts.high || 0) <= 2, `high ${counts.high} 条`);
  const weak = (counts.specific || 0) + (counts.unrelated || 0);
  assert.ok(weak >= 4, `specific+unrelated 只有 ${weak} 条`);
});

console.log("\n=== 3. 语义旁路：只允许 A 级跨查询提升 ===");
const mkProf = (tier, originQueryId) => ({
  entryId: "x", kind: tier === "A" ? "single-image-analysis" : "comparison-judgment",
  evidenceTier: tier, tierNote: tier === "A" ? null : "关系描述",
  source: { originQueryId },
  tokens: { composition: ["竖向", "居中"], subject: ["两人", "并肩"], space: ["街道"], colorLight: ["漫射", "冷灰"] },
});
const qp = { entryId: "q", evidenceTier: "A", kind: "single-image-analysis", tierNote: null,
  tokens: { composition: ["竖向", "居中"], subject: ["两人", "并肩"], space: ["街道"], colorLight: ["漫射", "冷灰"] } };

await check("A 级候选可跨查询命中且允许提升", () => {
  const r = sem.semanticDiscover(qp, new Map([["cand", mkProf("A", null)]]), "some-query");
  assert.equal(r.hits.length, 1);
  assert.equal(r.hits[0].eligibleForPromotion, true);
});

await check("B 级候选在别的查询下不命中", () => {
  const r = sem.semanticDiscover(qp, new Map([["cand", mkProf("B", "other-query")]]), "some-query");
  assert.equal(r.hits.length, 0, "B 级被跨查询复用");
  assert.equal(r.skippedTierB, 1);
});

await check("B 级在原始查询-候选对内可用但不允许提升", () => {
  const r = sem.semanticDiscover(qp, new Map([["cand", mkProf("B", "some-query")]]), "some-query");
  assert.equal(r.hits.length, 1);
  assert.equal(r.hits[0].eligibleForPromotion, false);
  assert.ok(r.hits[0].limitation, "缺少局限说明");
});

await check("C 级任何情况下都不参与", () => {
  const r = sem.semanticDiscover(qp, new Map([["cand", mkProf("C", "some-query")]]), "some-query");
  assert.equal(r.hits.length, 0);
  assert.equal(r.skippedTierC, 1);
});

console.log("\n=== 4. 人工复核入口 ===");
await check("产品字段保留证据留痕与待复核标记", () => {
  const p = vsFile.toProductJudgment(J({
    verdict: "partial",
    similarPoints: ["竖幅立轴构图，主峰居中偏上"],
    majorDifferences: ["候选为室内单人，查询为室外双人"],
    relationDerived: "specific",
    positiveDims: ["composition"],
    contradictedDims: { subject: "主体数量：单人 vs 多人" },
    evidenceNotes: ["subject 被差异推翻"],
  }));
  assert.equal(typeof p.needsReview, "boolean");
  assert.ok(Array.isArray(p.evidenceNotes));
  assert.ok(p.positiveDimensions, "缺少正面维度留痕");
  assert.ok(p.contradictedDimensions, "缺少被推翻维度留痕");
  assert.ok(p.confidenceLimitations.some((x) => /未经人工复核/.test(x)));
});

await check("档位变化会写进 reviewFlags", () => {
  const p = vsFile.toProductJudgment(J({
    verdict: "partial", verdictFromModel: "partial",
    downgraded: true, downgradeNote: "证据不足以支撑 partial：只剩色彩",
    similarPoints: ["低饱和冷调"], majorDifferences: ["室内 vs 室外"],
  }));
  assert.ok(p.reviewFlags.some((f) => /降级/.test(f)), `flags: ${p.reviewFlags.join(",")}`);
});

console.log(`\n=== P4.15.4 档位与证据复用: ${pass}/${pass + fail} PASS, ${fail} FAIL ===`);
if (fail > 0) process.exitCode = 1;
