// P4.3-D 二阶段可解释重排
//
// 设计原则（写进代码）：
//   1. 保留现有 scoreIntent 作为 baseline —— 不替换、不改权重
//   2. 二阶段只做「重排」，不改基础分；输出两个分数并说明各自来源
//   3. 核心视觉条件（主体/构图/空间）优先，色彩/肌理只在核心相近时才加分
//   4. 多样性约束：同一部片、近重复图像降权
//   5. 宽泛共同特征 → 标「跨传统灵感」，不伪装成高相似
//   6. 每条推荐至少 2 个具体依据，并能指出重要差异
//   7. 权重是待验证假设，不是调参凑结果
//
// 所有新增信号都来自 color-signatures.json（pixel-derived），不引入新网络调用。

import { scoreIntent } from "./scoring.js";
import { sharedReasons } from "./artworkIntent.js";
import { colorComparability } from "./colorSignatureBrowser.js";

/** 核心视觉字段：决定「画面结构是否相近」 */
export const CORE_FIELDS = [
  "subject", "subjectScale", "subjectPosition",
  "spatialDepth", "negativeSpace", "environmentDominance",
  "cameraDistance", "cameraHeight", "cameraRelation",
];

/** 次级字段：色彩/光线/肌理，只在核心相近时才参与加分 */
export const SECONDARY_FIELDS = [
  "lightDirection", "lightQuality", "colorTemperature",
  "saturation", "contrast", "visualDensity", "motion",
];

const FIELD_LABELS = {
  subject: "主体类型",
  subjectScale: "主体体量",
  subjectPosition: "主体位置",
  spatialDepth: "空间纵深",
  negativeSpace: "留白",
  environmentDominance: "环境主导",
  cameraDistance: "镜头距离",
  cameraHeight: "机位高度",
  cameraRelation: "镜头关系",
  lightDirection: "光向",
  lightQuality: "光质",
  colorTemperature: "色温",
  saturation: "饱和",
  contrast: "对比",
  visualDensity: "信息密度",
  motion: "运动感",
  humanRelation: "人物关系",
  socialDistance: "人际距离",
  melancholy: "忧郁感",
  arousal: "唤起度",
};

const label = (f) => FIELD_LABELS[f] || f;

/** 核心字段一致率：只统计「查询定义了且候选也有值」的字段 */
function coreAgreement(query, candidate) {
  let defined = 0, agree = 0;
  const agreeFields = [], differFields = [];
  for (const f of CORE_FIELDS) {
    const q = query[f];
    if (!q) continue;
    const c = candidate[f];
    if (!c) continue;
    defined++;
    if (c === q) { agree++; agreeFields.push(f); }
    else differFields.push({ field: f, query: q, candidate: c });
  }
  return { defined, agree, ratio: defined ? agree / defined : 0, agreeFields, differFields };
}

/** 色彩结构距离（0=相同，1=完全不同）。只用 pixel-derived 字段。 */
export function colorDistance(a, b) {
  if (!a || !b || !a.ok || !b.ok) return null;
  const x = a.colorSignature, y = b.colorSignature;
  const d = (p, q) => Math.abs(p - q);
  // 各项都已归一化到 0..1
  const dl = d(x.meanLightness, y.meanLightness);
  const ds = d(x.meanSaturation, y.meanSaturation);
  const dc = d(x.luminanceStd, y.luminanceStd);
  const dw = d(x.warmShare, y.warmShare) * 0.5 + d(x.coolShare, y.coolShare) * 0.5;
  const de = d(x.dominant?.[0]?.hsl?.h ?? 0, y.dominant?.[0]?.hsl?.h ?? 0) / 360; // 主色相
  const parts = [dl, ds, dc, dw, de];
  const dist = parts.reduce((s, v) => s + v, 0) / parts.length;
  return {
    distance: Math.round(dist * 1000) / 1000,
    components: {
      lightness: Math.round(dl * 1000) / 1000,
      saturation: Math.round(ds * 1000) / 1000,
      contrast: Math.round(dc * 1000) / 1000,
      warmcool: Math.round(dw * 1000) / 1000,
      dominantHue: Math.round(de * 1000) / 1000,
    },
  };
}

/** 色温/冷暖是否同一侧 */
function sameWarmth(a, b) {
  if (!a?.ok || !b?.ok) return null;
  const side = (s) => (s.colorSignature.warmShare > s.colorSignature.coolShare + 0.1 ? "warm"
    : s.colorSignature.coolShare > s.colorSignature.warmShare + 0.1 ? "cool" : "neutral");
  const sa = side(a), sb = side(b);
  return { a: sa, b: sb, same: sa === sb };
}

/**
 * 二阶段重排。
 * @param {object} query  VisualIntent（查询）
 * @param {Array} items   [{ artwork, intent, baseScore, baseReasons, medium, key }]
 * @param {object} sigs   color-signatures.json 的 signatures 映射
 * @param {object} querySig 查询自身的色彩签名（图片查询时有；文本查询为 null）
 */
export function rerank(query, items, sigs = {}, { querySig = null, limit = 8 } = {}) {
  const scored = items.map((it) => {
    // P4.4 — 优先使用缺失值感知排序分（qualityScore）；未提供时退回冻结 baseline。
    // 两者都保留在返回结构里，便于对照与解释。
    const frozenBaseline = it.baseScore ?? scoreIntent(query, it.intent).score;
    const base = typeof it.qualityScore === "number" ? it.qualityScore : frozenBaseline;
    const core = coreAgreement(query, it.intent);
    const sig = sigs[it.artwork?.id] || null;

    // ---- 二阶段加分：仅当核心结构确实相近 ----
    let colorBonus = 0;
    let colorNote = null;
    const cd = querySig && sig ? colorDistance(querySig, sig) : null;
    if (cd && core.ratio >= 0.5) {
      // MEASURED: on this asset set the raw distance spans only 0..0.19, so an
      // absolute formula like (1-dist)*2 produced ~0.4 of spread — invisible
      // next to base scores that differ by 5+. Normalise by the candidate
      // pool's own distance range instead: this is a RELATIVE comparison,
      // which is also the honest framing ("more/less similar than the rest").
      colorBonus = 0; // filled after the pool-wide normalisation below
      const w = sameWarmth(querySig, sig);
      colorNote = `色彩结构距离 ${cd.distance}（明度 ${cd.components.lightness} / 饱和 ${cd.components.saturation} / 冷暖 ${cd.components.warmcool}）`;
      if (w && w.same) colorNote += `；冷暖同侧（${w.a}）`;
    }

    // ---- 跨传统判定：核心相近但次级差异大 ----
    const secondaryAgree = SECONDARY_FIELDS.filter((f) => query[f] && it.intent?.[f] === query[f]).length;
    const secondaryDefined = SECONDARY_FIELDS.filter((f) => query[f] && it.intent?.[f]).length;
    const crossTradition =
      core.defined >= 2 && core.ratio >= 0.5 &&
      secondaryDefined >= 2 && secondaryAgree / secondaryDefined < 0.34;

    return {
      item: it,
      artwork: it.artwork,
      medium: it.medium || "artwork",
      intentProvenance: it.intentProvenance,
      reasons: it.baseReasons || it.reasons || [],
      baseScore: base,
    frozenBaselineScore: frozenBaseline,
    usedMissingAwareScore: typeof it.qualityScore === "number",
      core,
      colorBonus,
      colorNote,
      colorDelta: cd,
      secondaryAgree,
      secondaryDefined,
      crossTradition,
      rerankScore: Math.round((base + colorBonus) * 10) / 10,
    };
  });

  // ---- 色彩加分归一化：按本候选池的距离分布，而非绝对阈值 ----
  // 只有核心结构达标（core.ratio >= 0.5）的候选参与，避免用色彩掩盖结构不符。
  {
    const eligible = scored.filter((x) => x.colorDelta && x.core.ratio >= 0.5);
    if (eligible.length > 1) {
      const dists = eligible.map((x) => x.colorDelta.distance);
      const dmin = Math.min(...dists);
      const dmax = Math.max(...dists);
      const span = dmax - dmin;
      for (const x of scored) {
        if (!x.colorDelta || x.core.ratio < 0.5) { x.colorBonus = 0; continue; }
        // 0 = 池内最近，1 = 池内最远；上限 2.5，仍小于最强核心字段(3.0)
        const rel = span > 1e-6 ? (x.colorDelta.distance - dmin) / span : 0;
        let bonus = (1 - rel) * 2.5;
        // P4.4 — 色彩可比性分级。黑白画面的「色温/饱和」不是有效证据：
        // 拿它与彩色查询比距离，会把噪声当成相似度（实测 diary-lost-girl
        // 是黑白帧却拿到 1.8 分）。因此按 mode 打折，并记录原因供解释使用。
        const candSig = sigs[x.artwork?.id];
        const cmpCand = colorComparability(candSig);
        const cmpQuery = colorComparability(querySig);
        let comparability = 1;
        let comparabilityNote = null;
        if (cmpCand.mode === "monochrome" || cmpQuery.mode === "monochrome") {
          comparability = 0; // 黑白 vs 彩色：色彩证据完全不可比，不给加分
          comparabilityNote = "黑白影像与彩色查询的色彩证据不可比，本项不计加分";
        } else if (cmpCand.mode === "low-saturation" || cmpQuery.mode === "low-saturation") {
          comparability = 0.4;
          comparabilityNote = "低饱和画面，色彩证据权重下调";
        }
        bonus = bonus * comparability;
        x.comparability = { mode: cmpCand.mode, queryMode: cmpQuery.mode, factor: comparability, note: comparabilityNote };
        x.colorBonus = Math.round(bonus * 10) / 10;
        x.rerankScore = Math.round((x.baseScore + x.colorBonus) * 10) / 10;
      }
    }
  }

  // ---- 多样性：同一部片 / 近重复降权 ----
  scored.sort((a, b) => b.rerankScore - a.rerankScore);
  const seenFilm = new Map();   // filmTitle -> count
  const seenSig = [];           // 用于近重复检测
  const NON_DUP_DIST = 0.04;    // 色彩签名距离低于此视为近重复

  for (const s of scored) {
    const filmTitle = s.artwork?.film?.title || null;
    s.diversityPenalty = 0;

    if (filmTitle) {
      const n = seenFilm.get(filmTitle) || 0;
      if (n > 0) s.diversityPenalty += 3 * n; // 同片第二张起显著降权
      seenFilm.set(filmTitle, n + 1);
    }
    const sig = sigs[s.artwork?.id];
    if (sig?.ok) {
      for (const prev of seenSig) {
        const d = colorDistance(prev.sig, sig);
        if (d && d.distance < NON_DUP_DIST) {
          s.diversityPenalty += 2.5;
          s.nearDuplicateOf = prev.id;
          break;
        }
      }
      seenSig.push({ id: s.artwork?.id, sig });
    }
    s.finalScore = Math.round((s.rerankScore - s.diversityPenalty) * 10) / 10;
  }

  scored.sort((a, b) => b.finalScore - a.finalScore);
  return scored.slice(0, limit).map((s, i) => ({ ...s, rank: i + 1 }));
}

/**
 * 生成可解释的推荐说明：至少 2 个具体匹配依据 + 至少 1 个重要差异。
 * 不够 2 个依据时如实返回 insufficient，不硬凑。
 */
export function explain(s, query) {
  const evidence = [];
  const differences = [];

  // 1. 核心结构匹配
  for (const f of s.core.agreeFields.slice(0, 3)) {
    evidence.push({ kind: "core", text: `${label(f)}一致（${query[f]}）` });
  }
  // 2. 色彩结构
  if (s.colorNote && s.colorBonus > 0) {
    evidence.push({ kind: "color", text: s.colorNote });
  }
  // 3. 次级字段匹配
  for (const f of SECONDARY_FIELDS) {
    if (query[f] && s.item.intent?.[f] === query[f] && evidence.length < 4) {
      evidence.push({ kind: "secondary", text: `${label(f)}一致（${query[f]}）` });
    }
  }
  // 差异
  for (const d of s.core.differFields.slice(0, 2)) {
    differences.push({ kind: "core", text: `${label(d.field)}不同（你的是 ${d.query}，这件是 ${d.candidate}）` });
  }
  if (s.colorDelta && s.colorDelta.distance > 0.35) {
    differences.push({ kind: "color", text: `色彩结构差异较大（距离 ${s.colorDelta.distance}）` });
  }
  if (s.crossTradition) {
    differences.push({ kind: "context", text: "核心结构相近但光线/色彩组织明显不同，属跨传统灵感而非高相似" });
  }

  return {
    rank: s.rank,
    key: s.artwork?.key || s.artwork?.id,
    id: s.artwork?.id,
    medium: s.medium,
    baseScore: s.baseScore,
    colorBonus: s.colorBonus,
    diversityPenalty: s.diversityPenalty,
    finalScore: s.finalScore,
    crossTradition: s.crossTradition,
    nearDuplicateOf: s.nearDuplicateOf || null,
    evidence,
    differences,
    sufficient: evidence.length >= 2,
    ifInsufficient: evidence.length >= 2 ? null : "匹配依据不足 2 条，不应作为强推荐",
  };
}
