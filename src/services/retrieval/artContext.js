// P4.3-C Art Context —— 艺术语境数据契约
//
// 严格区分四类信息，任何一类都不得冒充另一类：
//
//   A. historical   作品真实历史与创作背景   —— 必须有出处，否则 unknown
//   B. observable   画面内可观察的形式与关系 —— 来自像素或策展描述，可比对
//   C. interpretation 基于证据的艺术解释     —— 必须标 evidence 与 confidence
//   D. cinematic    电影镜头的真实叙事语境   —— 只有取得场景证据时才填
//
// 硬约束（写进代码而不是只写在注释里）：
//   1. 未提供出处 → status:"unknown"，不留空字符串假装有值
//   2. 创作故事不得作为匹配特征；导出函数明确标注 matchable:false
//   3. 置信度只能是 high / medium / low / unknown，且 high 必须带 sourceUrl
//
// 本模块不读网络、不调模型；只做结构校验与归类。

export const EVIDENCE_TYPES = [
  "pixel-observed",     // 从本地图像像素直接测得
  "curator-text",       // 策展人撰写的描述（不是馆方 medium 字段）
  "museum-record",      // 馆方 API 的结构化记录
  "commons-metadata",   // Wikimedia Commons 元数据
  "wikidata",           // Wikidata 结构化事实
  "model-inference",    // 模型推断（本项目当前不产生）
  "none",               // 无依据
];

export const CONFIDENCE = ["high", "medium", "low", "unknown"];

/** 一个 Art Context 节的统一形状 */
function section({ type, claims, evidenceType, confidence, sourceUrl = null, matchable }) {
  if (!CONFIDENCE.includes(confidence)) {
    throw new Error(`ArtContext: invalid confidence "${confidence}"`);
  }
  if (!EVIDENCE_TYPES.includes(evidenceType)) {
    throw new Error(`ArtContext: invalid evidenceType "${evidenceType}"`);
  }
  // high 置信度必须可追溯
  if (confidence === "high" && !sourceUrl) {
    throw new Error(`ArtContext: confidence "high" requires sourceUrl (${type})`);
  }
  const clean = (claims || [])
    .filter((c) => c && typeof c.text === "string" && c.text.trim())
    .map((c) => ({ text: c.text.trim(), ...(c.field ? { field: c.field } : {}) }));
  return {
    type,
    status: clean.length ? (confidence === "unknown" ? "unknown" : "known") : "unknown",
    claims: clean,
    evidenceType,
    confidence,
    sourceUrl,
    // 决定这一节能否参与「视觉相似」——故事永远不能
    matchable: Boolean(matchable),
  };
}

/**
 * 构建 Art Context。
 * @param {object} input
 * @param {object} input.artwork  作品记录（可为空）
 * @param {object|null} input.signature  色彩签名（pixel-observed）
 */
export function buildArtContext({ artwork = null, signature = null } = {}) {
  const a = artwork || {};
  const out = {
    version: 1,
    historical: null,
    observable: null,
    interpretation: null,
    cinematic: null,
  };

  // ---- B. observable：像素可观测（优先，最可靠）----
  const observed = [];
  if (signature && signature.ok) {
    const cs = signature.colorSignature;
    observed.push({ text: `平均明度 ${cs.meanLightness}`, field: "meanLightness" });
    observed.push({ text: `平均饱和度 ${cs.meanSaturation}`, field: "meanSaturation" });
    if (cs.subjectBackground) {
      const rel = cs.subjectBackground.subjectVsBackground;
      const human = { "subject-lighter": "主体比背景更亮", "subject-darker": "主体比背景更暗", similar: "主体与背景亮度接近" }[rel];
      if (human) observed.push({ text: human, field: "subjectVsBackground" });
    }
    const warmLead = cs.warmShare > cs.coolShare ? "偏暖" : cs.coolShare > cs.warmShare ? "偏冷" : "冷暖均衡";
    observed.push({ text: `色彩${warmLead}（暖 ${(cs.warmShare * 100).toFixed(0)}% / 冷 ${(cs.coolShare * 100).toFixed(0)}%）`, field: "warmShare" });
  }
  // 策展描述里的形式观察（非 pixel）
  const curatorObs = [];
  if (a.composition) curatorObs.push({ text: a.composition, field: "composition" });
  if (a.lighting) curatorObs.push({ text: a.lighting, field: "lighting" });
  if (a.spatialStructure) curatorObs.push({ text: a.spatialStructure, field: "spatialStructure" });

  out.observable = observed.length
    ? section({
        type: "observable",
        claims: observed,
        evidenceType: "pixel-observed",
        confidence: "high",
        sourceUrl: "local://public/assets",
        matchable: true,
      })
    : null;

  // 策展描述单列一节，confidence 不高，且不是 pixel
  if (curatorObs.length) {
    out.observableCurator = section({
      type: "observable",
      claims: curatorObs,
      evidenceType: "curator-text",
      confidence: "medium",
      sourceUrl: a.source?.url || null,
      matchable: true,
    });
  }

  // ---- A. historical：真实历史与创作背景 ----
  // 本项目没有逐件历史档案，只有 year/artist/museum 这类事实字段。
  const hist = [];
  if (a.year) hist.push({ text: `创作年代 ${a.year}`, field: "year" });
  if (a.artist) hist.push({ text: `作者 ${a.artist}`, field: "artist" });
  if (a.museum) hist.push({ text: `收藏 ${a.museum}`, field: "museum" });
  out.historical = hist.length
    ? section({
        type: "historical",
        claims: hist,
        evidenceType: a.source?.url ? "museum-record" : "none",
        confidence: a.source?.url ? "medium" : "low",
        sourceUrl: a.source?.url || null,
        matchable: false, // 年代/作者不是视觉相似依据
      })
    : { type: "historical", status: "unknown", claims: [], evidenceType: "none", confidence: "unknown", sourceUrl: null, matchable: false };

  // ---- C. interpretation：基于证据的解释 ----
  // 只有策展描述存在时才能给解释；且必须标 medium 或更低。
  const interp = [];
  if (a.oneLine) interp.push({ text: a.oneLine });
  if (a.narrativeFunction?.length) {
    interp.push({ text: `叙事功能：${a.narrativeFunction.join("、")}` });
  }
  out.interpretation = interp.length
    ? section({
        type: "interpretation",
        claims: interp,
        evidenceType: "curator-text",
        confidence: "low", // 解释性内容一律低置信
        sourceUrl: a.source?.url || null,
        matchable: false, // 解释不得参与相似度
      })
    : { type: "interpretation", status: "unknown", claims: [], evidenceType: "none", confidence: "unknown", sourceUrl: null, matchable: false };

  // ---- D. cinematic：电影叙事语境 ----
  // 只有从 Commons/Wikidata 真正取得场景证据时才填；否则显式 unknown。
  // 本地 15 帧有片名/年份/导演（身份已核实），但记录里**没有** scene/plot/synopsis
  // 字段，所以这里必须是 unknown —— 不能拿影片身份冒充镜头叙事语境。
  if (a.medium === "film") {
    const filmMeta = a.film || {};
    const sceneText = filmMeta.scene || filmMeta.plot || filmMeta.synopsis || "";
    out.cinematic = sceneText
      ? section({
          type: "cinematic",
          claims: [{ text: sceneText }],
          evidenceType: "commons-metadata",
          confidence: "medium",
          sourceUrl: a.source?.url || null,
          matchable: false,
        })
      : {
          type: "cinematic",
          status: "unknown",
          claims: [],
          evidenceType: "none",
          confidence: "unknown",
          sourceUrl: null,
          matchable: false,
          reason: "已取得影片身份与许可，但无该帧的场景叙事证据",
        };
  } else {
    out.cinematic = {
      type: "cinematic",
      status: "not-applicable",
      claims: [],
      evidenceType: "none",
      confidence: "unknown",
      sourceUrl: null,
      matchable: false,
      reason: "非电影素材",
    };
  }
  return out;
}

/** 明确回答"这一节能不能用于相似度计算" —— 供重排层读取，避免各自解释 */
export function isMatchable(contextSection) {
  return Boolean(contextSection && contextSection.matchable === true && contextSection.status === "known");
}

/** 汇总：只返回可匹配的观察项，供二阶段重排使用 */
export function matchableObservations(context) {
  if (!context) return [];
  const out = [];
  for (const key of ["observable", "observableCurator"]) {
    const s = context[key];
    if (isMatchable(s)) out.push(...s.claims);
  }
  return out;
}

export const ART_CONTEXT_CONTRACT = {
  sections: ["historical", "observable", "interpretation", "cinematic"],
  matchableSections: ["observable"],
  // 永远不可作为匹配依据的
  neverMatchable: ["historical", "interpretation", "cinematic"],
  rule: "创作故事与艺术解释不得替代画面相似",
};
