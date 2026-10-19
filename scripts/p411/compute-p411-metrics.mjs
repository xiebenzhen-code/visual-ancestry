// compute-p411-metrics.mjs — P4.11 STEP 4 预留的离线指标计算
//
// 状态：**未运行**。用户评分落盘之前，这里不产出任何数字。
//
// 设计立场（为什么写成这样）：
//   1. 不预填指标，不把"缺人工标注"记成 0 分。没有评分就明确说"未评测"。
//   2. nDCG / P@5 必须同时报 DCG、IDCG 原值与逐位 gain —— 只报归一化值会把
//      "换掉了哪一条"藏起来。
//   3. 平局与矛盾对不进一致率分母。分母小到个位数时，一致率只是硬币。
//   4. 四组敏感性权重必须同时报。四组方向不一致就不许下"哪个基线更好"的结论。
//
// 用法：
//   node scripts/p411/compute-p411-metrics.mjs <scores.json>
//   其中 scores.json 是盲评页导出的 p411-scores-*.json

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SAMPLE_PATH = path.join(ROOT, ".rc1-audit/p411/p411-sample.json");
const ANSWERS_PATH = path.join(ROOT, ".rc1-audit/p411/p411-answers.json");

// ---- 预注册的权重（改动必须同时改 rubricVersion） ----
const RUBRIC_VERSION = "p411-rubric-v1";
const WEIGHTS = {
  // 主：形式优先（形式两项 0.55 / 内容两项 0.45）
  primary: { D1: 0.40, D2: 0.30, D3: 0.15, D4: 0.15 },
  // 敏感性 A：等权
  equal: { D1: 0.25, D2: 0.25, D3: 0.25, D4: 0.25 },
  // 敏感性 B：形式项加倍
  formHeavy: { D1: 0.50, D2: 0.35, D3: 0.075, D4: 0.075 },
  // 敏感性 C：只用 D1
  onlyD1: { D1: 1, D2: 0, D3: 0, D4: 0 },
  // 敏感性 D：去掉 D3（建筑道具最容易被题材标签反推）
  noD3: { D1: 0.47, D2: 0.35, D3: 0, D4: 0.18 },
};

// 预注册的相关性阈值：相关 := D1 >= 2（构念定义在主指标上）
const RELEVANT_RULE = { kind: "D1>=", dim: "D1", threshold: 2 };
// 敏感性阈值：R >= 1.5
const RELEVANT_RULE_ALT = { kind: "R>=", threshold: 1.5 };

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

// ---- 聚合：R = Σ w·D，NA 按已观测维度重新归一 ----
function relevance(scores, weights) {
  const keys = Object.keys(weights).filter((k) => weights[k] > 0);
  let num = 0;
  let denom = 0;
  let hasNA = false;
  let d1 = null;
  for (const k of keys) {
    const v = scores[k];
    if (v === undefined) return { value: null, reason: "未填" };
    if (v === "NA") { hasNA = true; continue; }
    num += Number(v) * weights[k];
    denom += weights[k];
    if (k === "D1") d1 = Number(v);
  }
  if (denom === 0) return { value: null, reason: "全部 NA" };
  let r = num / denom;
  // D1 闸门：D1=0 → R≤1.0；D1=1 → R≤2.0
  if (d1 === 0) r = Math.min(r, 1.0);
  else if (d1 === 1) r = Math.min(r, 2.0);
  return { value: Math.round(r * 20) / 20, hasNA, d1, reason: hasNA ? "含 NA，已按已观测维度归一" : "" };
}

function dcg(gains, k) {
  let s = 0;
  for (let i = 0; i < Math.min(k, gains.length); i++) s += gains[i] / Math.log2(i + 2);
  return s;
}
function ndcg(gainsInRankOrder, idealDesc, k) {
  const idcg = dcg(idealDesc, k);
  if (idcg === 0) return null;
  return dcg(gainsInRankOrder, k) / idcg;
}

// ---- 两两可判定性 ----
function comparePairs(rows) {
  const out = { decidable: [], tie: [], conflict: [] };
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i], b = rows[j];
      const dims = ["D1", "D2", "D3", "D4"];
      // Pareto 支配
      let aWins = true, bWins = true, anyStrict = false;
      for (const d of dims) {
        const av = a.scores[d], bv = b.scores[d];
        if (av === "NA" || bv === "NA" || av === undefined || bv === undefined) { aWins = bWins = false; break; }
        if (av < bv) aWins = false;
        if (bv < av) bWins = false;
        if (av !== bv) anyStrict = true;
      }
      const dr = Math.abs((a.R ?? 0) - (b.R ?? 0));
      let dimDiffBig = false;
      for (const d of dims) {
        const av = a.scores[d], bv = b.scores[d];
        if (typeof av === "number" && typeof bv === "number" && Math.abs(av - bv) >= 2) dimDiffBig = true;
      }
      const pair = { a: a.blindId, b: b.blindId, dR: Math.round(dr * 100) / 100 };
      if ((aWins || bWins) && anyStrict) out.decidable.push({ ...pair, winner: aWins ? a.blindId : b.blindId, basis: "pareto" });
      else if (dr >= 0.6 && !dimDiffBig) out.decidable.push({ ...pair, winner: a.R > b.R ? a.blindId : b.blindId, basis: "dR>=0.6" });
      else if (dr < 0.3 && !dimDiffBig) out.tie.push(pair);
      else out.conflict.push({ ...pair, reason: "维度方向冲突且无支配" });
    }
  }
  return out;
}

// ---- 主流程 ----
const scorePath = process.argv[2];
if (!scorePath) {
  console.error("用法: node scripts/p411/compute-p411-metrics.mjs <p411-scores-*.json>");
  console.error("");
  console.error("当前状态：**未评测**。用户尚未提交评分，因此不产出任何指标数字。");
  console.error("这不是「指标为 0」——是「还没有可算的数据」。两者不能混写。");
  process.exit(2);
}

const sample = readJson(SAMPLE_PATH);
const answers = readJson(ANSWERS_PATH);
const record = readJson(scorePath);

// ---- 一致性校验：防止拿错版本的评分去算 ----
const problems = [];
if (record.sampleId !== sample.sampleId) problems.push(`sampleId 不符: ${record.sampleId} vs ${sample.sampleId}`);
if (record.rubricVersion !== RUBRIC_VERSION) problems.push(`rubricVersion 不符: ${record.rubricVersion} vs ${RUBRIC_VERSION}`);
if (record.baseCommit !== sample.baseCommit) problems.push(`baseCommit 不符: ${record.baseCommit} vs ${sample.baseCommit}`);
if (problems.length) {
  console.error("拒绝计算 —— 评分记录与样本/量表版本不一致:");
  problems.forEach((p) => console.error("  - " + p));
  process.exit(3);
}

const byBlind = new Map(answers.map.map((m) => [m.blindId, m]));
const rows = [];
for (const m of answers.map) {
  const s = record.scores[m.blindId] || {};
  const r = relevance(s, WEIGHTS.primary);
  rows.push({ blindId: m.blindId, scores: s, R: r.value, Rnote: r.reason, meta: m });
}

console.log("=== 逐条 relevance ===");
for (const r of rows) {
  console.log(`  ${r.blindId}  R=${r.R === null ? "未计(" + r.Rnote + ")" : r.R}  D=[${["D1","D2","D3","D4"].map(d=>r.scores[d] ?? "·").join(",")}]  rank=${r.meta.systemRank}  ${r.meta.media}`);
}

// ---- 两个基线：真实排名 vs 按像素距离（P4.10 已证明不排序，这里只作对照） ----
// 基线 A = 样本采集时记录的 systemRank（现有系统）
const baselineA = [...rows].sort((a, b) => a.meta.systemRank - b.meta.systemRank).map((r) => r.blindId);
// 基线 B 需要 P4.10 的像素距离，若样本文件里没有就明确标 unavailable
const hasPixel = sample.candidates.every((c) => typeof c.pixelDistance === "number");
const baselineB = hasPixel
  ? [...sample.candidates].sort((a, b) => a.pixelDistance - b.pixelDistance).map((c) => c.blindId)
  : null;

if (!baselineB) {
  console.log("\n基线 B（P4.10 像素距离排序）：**不可用** —— 样本文件未记录 pixelDistance。");
  console.log("  这不是「基线 B 表现差」，是没有该数据。不得填 0。");
}

// ---- 指标 ----
function report(baselineName, order, weights) {
  const rr = rows.map((r) => ({ ...r, R: relevance(r.scores, weights).value }));
  const byId = new Map(rr.map((r) => [r.blindId, r]));
  const gainsRank = order.map((b) => byId.get(b).R ?? 0);
  const ideal = [...gainsRank].sort((a, b) => b - a);

  const out = { baseline: baselineName, weights };
  out.ndcg5 = ndcg(gainsRank, ideal, 5);
  out.ndcg8 = ndcg(gainsRank, ideal, 8);
  out.dcg5 = Math.round(dcg(gainsRank, 5) * 1000) / 1000;
  out.idcg5 = Math.round(dcg(ideal, 5) * 1000) / 1000;
  out.gains = gainsRank.map((g) => Math.round(g * 100) / 100);

  // P@5：预注册阈值 相关 := D1>=2
  const top5 = order.slice(0, 5).map((b) => byId.get(b));
  out.p5_d1 = `${top5.filter((r) => typeof r.scores.D1 === "number" && r.scores.D1 >= 2).length}/5`;
  // 敏感性：R>=1.5
  out.p5_r = `${top5.filter((r) => (r.R ?? 0) >= 1.5).length}/5`;

  if (baselineB) {
    const pairs = comparePairs(rr);
    let agree = 0, disagree = 0;
    const posA = new Map(baselineA.map((b, i) => [b, i]));
    const posB = new Map(baselineB.map((b, i) => [b, i]));
    for (const p of pairs.decidable) {
      const aOrder = posA.get(p.a) < posA.get(p.b) ? p.a : p.b;
      const bOrder = posB.get(p.a) < posB.get(p.b) ? p.a : p.b;
      if (aOrder === bOrder) agree++; else disagree++;
    }
    out.pairwise = { decidable: pairs.decidable.length, tie: pairs.tie.length, conflict: pairs.conflict.length, agree, disagree };
  }
  return out;
}

console.log("\n=== 基线 A（现有系统排名）===");
console.log("  顺序:", baselineA.join(" → "));
const resA = report("A-system", baselineA, WEIGHTS.primary);
console.log(`  nDCG@5=${resA.ndcg5?.toFixed(2)}  nDCG@8=${resA.ndcg8?.toFixed(2)}  DCG@5=${resA.dcg5}  IDCG@5=${resA.idcg5}`);
console.log(`  P@5(D1>=2)=${resA.p5_d1}   P@5(R>=1.5)=${resA.p5_r}`);

console.log("\n=== 四组敏感性（基线 A）===");
for (const [name, w] of Object.entries(WEIGHTS)) {
  const r = report("A-" + name, baselineA, w);
  console.log(`  ${name.padEnd(10)} nDCG@5=${r.ndcg5?.toFixed(2)}  P@5(D1>=2)=${r.p5_d1}  P@5(R>=1.5)=${r.p5_r}`);
}

if (baselineB) {
  console.log("\n=== 基线 B（P4.10 像素距离）===");
  console.log("  顺序:", baselineB.join(" → "));
  const resB = report("B-pixel", baselineB, WEIGHTS.primary);
  console.log(`  nDCG@5=${resB.ndcg5?.toFixed(2)}  nDCG@8=${resB.ndcg8?.toFixed(2)}`);
  console.log(`  P@5(D1>=2)=${resB.p5_d1}   P@5(R>=1.5)=${resB.p5_r}`);
}

console.log("\n=== 必须随数字一起报的局限 ===");
console.log("  · 单人、单次、8 候选、1 条查询。无置信区间，不做显著性检验。");
console.log("  · nDCG 报 2 位小数；差值 < 0.05 一律写「无法区分」。");
console.log("  · 不得把 Top5 覆盖 62.5% 当作质量证据（5 是任意截断）。");
console.log("  · 四组敏感性方向不一致时，不许下「哪个基线更好」的结论。");
console.log("  · 不得外推到其他查询或其他候选池。");
