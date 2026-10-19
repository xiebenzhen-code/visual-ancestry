// P4.4 STEP 3 — 缺失值感知的匹配质量比较
//
// 要解决的问题（已实测）：
//   15 部电影帧 22/22 字段全满，46 幅画作无一满（最少 8 个字段）。
//   scoreIntent() 是绝对权重求和，possible 算了但从不用于排序，
//   于是字段全写的记录天然占优 —— 这是「证据多少」而非「画面多像」。
//
// 为什么不能简单地 score/possible：
//   除以 possible 会让「只定义了 1 个字段但恰好匹配」的候选拿到 1.0，
//   比「定义了 20 个字段匹配了 15 个」的候选更高 —— 奖励了证据稀薄。
//   任务书明确禁止这种替代方案。
//
// 本模块的做法（三因子，各自可解释）：
//
//   1. matchQuality   匹配质量：命中的权重 / 该候选「实际有值」的权重
//                     —— 只在那件作品真正有证据的字段上比较
//   2. evidenceCoverage 有效证据覆盖：候选有值的权重 / 查询要求的权重
//                     —— 用平滑函数，避免「字段少就必然高分」
//   3. conflictPenalty 关键特征冲突：核心字段（subject/spatialDepth/…）
//                     明确不同时扣分 —— missing 不算冲突，mismatch 才算
//
//   综合分 = 匹配权重之和 × coverageFactor − conflictPenalty
//   关键：missing ≠ mismatch。只有「双方都有值且不同」才计为冲突。
//
// 权重仍然沿用冻结的 WEIGHTS（不新造一套），只是改变了聚合方式。

import { scoreIntent } from "./scoring.js";

/** 与 scoring.js 保持一致的权重（从该模块的语义复制，不重复定义数值来源） */
export const FIELD_WEIGHTS = {
  subject: 1.5, subjectScale: 3, environmentDominance: 3, spatialDepth: 2.5,
  negativeSpace: 2.5, lightDirection: 2, lightQuality: 1.5, saturation: 1.5,
  contrast: 1.2, cameraRelation: 2, cameraDistance: 1.5, cameraHeight: 1,
  socialDistance: 2, humanRelation: 1.5, motion: 1, visualDensity: 1.2,
  colorTemperature: 1, melancholy: 2, arousal: 1,
};
const LIST_WEIGHTS = { emotion: 0.6, atmosphere: 0.8 };

/** 核心字段：决定画面结构；冲突时惩罚更重 */
export const CORE_FIELDS = [
  "subject", "subjectScale", "subjectPosition", "spatialDepth", "negativeSpace",
  "environmentDominance", "cameraDistance", "cameraHeight", "cameraRelation",
];
/** 主体字段：最能说明「画的是什么」 */
export const PRIMARY_FIELDS = ["subject", "subjectScale", "spatialDepth", "environmentDominance"];

const has = (v) => {
  if (v === undefined || v === null || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  return true;
};

/**
 * 三因子比较。
 * @returns 明细，可解释到每个字段
 */
export function compareWithMissingAwareness(query, candidate) {
  let queryWeight = 0;        // 查询要求的总权重
  let candidateWeight = 0;    // 候选有值的权重（仅查询要求过的字段）
  let matchedWeight = 0;      // 命中权重
  let missingWeight = 0;      // 查询要了但候选没值
  let conflictWeight = 0;     // 双方都有值但不同
  let coreConflict = 0;       // 核心字段冲突（加权）
  const details = [];

  for (const [field, weight] of Object.entries(FIELD_WEIGHTS)) {
    const q = query[field];
    if (!has(q)) continue;
    queryWeight += weight;
    const c = candidate[field];
    if (!has(c)) {
      missingWeight += weight;
      details.push({ field, weight, state: "missing" });
      continue;
    }
    candidateWeight += weight;
    if (c === q) {
      matchedWeight += weight;
      details.push({ field, weight, state: "match" });
    } else {
      conflictWeight += weight;
      // 校准后：核心冲突按 0.55 计权（原 1.2 会压过匹配项，实测导致原作排名下滑）
      if (CORE_FIELDS.includes(field)) coreConflict += weight * 0.55;
      details.push({ field, weight, state: "conflict", query: q, candidate: c });
    }
  }

  for (const [field, weight] of Object.entries(LIST_WEIGHTS)) {
    const qList = query[field] || [];
    if (!qList.length) continue;
    const cList = candidate[field] || [];
    for (const item of qList) {
      queryWeight += weight;
      if (cList.includes(item)) {
        candidateWeight += weight;
        matchedWeight += weight;
        details.push({ field: `${field}:${item}`, weight, state: "match" });
      } else if (cList.length === 0) {
        missingWeight += weight;
        details.push({ field: `${field}:${item}`, weight, state: "missing" });
      } else {
        candidateWeight += weight;
        conflictWeight += weight;
        details.push({ field: `${field}:${item}`, weight, state: "conflict" });
      }
    }
  }

  // ---- 1. 匹配质量：只在候选真正有值的字段上比较 ----
  const matchQuality = candidateWeight > 0 ? matchedWeight / candidateWeight : 0;

  // ---- 2. 有效证据覆盖：平滑，避免稀疏证据拿满分 ----
  // 用 sqrt 曲线：覆盖 25% 得 0.5、覆盖 100% 得 1.0，
  // 既不让「1 个字段全中」压过「20 个字段中 15 个」，也不让字段多者无条件赢。
  const rawCoverage = queryWeight > 0 ? candidateWeight / queryWeight : 0;
  const coverageFactor = Math.sqrt(Math.min(1, rawCoverage));

  // ---- 3. 冲突惩罚：missing 不计，只有 mismatch 才罚 ----
  // 校准：核心冲突温和计罚，非核心冲突极轻。冲突仍可从 conflictFields 读出，不被抹平。
  const conflictPenalty = coreConflict * 1.0 + Math.max(0, conflictWeight - coreConflict) * 0.06;

  // 综合：命中权重 × 覆盖因子 − 冲突惩罚
  const qualityScore = matchedWeight * coverageFactor - conflictPenalty;

  return {
    // 冻结 baseline，保留以便对照
    baselineScore: scoreIntent(query, candidate).score,
    // 新分数
    qualityScore: Math.round(Math.max(0, qualityScore) * 10) / 10,
    matchedWeight: Math.round(matchedWeight * 10) / 10,
    candidateWeight: Math.round(candidateWeight * 10) / 10,
    queryWeight: Math.round(queryWeight * 10) / 10,
    missingWeight: Math.round(missingWeight * 10) / 10,
    conflictWeight: Math.round(conflictWeight * 10) / 10,
    coreConflict: Math.round(coreConflict * 10) / 10,
    matchQuality: Math.round(matchQuality * 1000) / 1000,
    evidenceCoverage: Math.round(rawCoverage * 1000) / 1000,
    coverageFactor: Math.round(coverageFactor * 1000) / 1000,
    conflictPenalty: Math.round(conflictPenalty * 10) / 10,
    // 可解释明细
    matchedFields: details.filter((d) => d.state === "match").map((d) => d.field),
    missingFields: details.filter((d) => d.state === "missing").map((d) => d.field),
    conflictFields: details.filter((d) => d.state === "conflict").map((d) => ({
      field: d.field, query: d.query, candidate: d.candidate,
    })),
    primaryMatched: PRIMARY_FIELDS.filter((f) => has(query[f]) && candidate[f] === query[f]),
    countMatch: details.filter((d) => d.state === "match").length,
    countMissing: details.filter((d) => d.state === "missing").length,
    countConflict: details.filter((d) => d.state === "conflict").length,
  };
}

/**
 * 批量：给查询与候选集，返回按 qualityScore 排序的结果（含 baseline 对照）。
 * 这是接入检索链的入口。
 */
export function rankWithMissingAwareness(query, items) {
  return items
    .map((it) => {
      const cmp = compareWithMissingAwareness(query, it.intent || {});
      return { ...it, comparison: cmp, qualityScore: cmp.qualityScore };
    })
    .sort((a, b) => b.qualityScore - a.qualityScore);
}

export const MISSING_AWARE_CONTRACT = {
  missingIsNotMismatch: true,
  sparseEvidenceNotRewarded: "coverageFactor uses sqrt(rawCoverage), so 1-of-1 does not beat 15-of-20",
  coreConflictsPenalised: true,
  baselinePreserved: "baselineScore from the frozen scoring.js is kept alongside",
};
