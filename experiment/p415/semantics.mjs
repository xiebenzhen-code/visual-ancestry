// semantics.mjs — P4.15.2 VisualAnalysis V2 语义召回路径
//
// 数据来源只有两种，都是**已经花过钱、核实过**的模型输出：
//   1. 预检阶段的单图 V2 分析（preflight-state.json → results.A.analysis）
//   2. 真实多图比较的缓存（cache/*.json → payload.judgments[i]）
//
// 三条纪律：
//   · 没有画像的候选一律标 unanalyzed。标题、VisualIntent、流派标签都
//     不能冒充 V2 图像语义——VisualIntent 是元数据，不是看图得来的。
//   · 查询自己没有画像时，语义路径整体跳过并说明原因；唯一的例外是
//     「从比较差异文本里反推查询特征」，必须标 derived，可信度降级。
//   · 语义匹配只用于「发现候选」，不写入正式排序权重（RRF 不吃它）。

import fs from "node:fs";
import path from "node:path";

const DIMENSIONS = ["composition", "subject", "space", "colorLight"];

/** 每个维度的可匹配词。宁缺毋滥：匹配上的必须能在原文里指出同一处。 */
const TOKENS = {
  composition: ["竖向", "横向", "对称", "三角", "并排", "并立", "居中", "偏右", "偏左", "长卷", "对角", "留白", "近景", "远景", "特写", "全身", "半身", "层叠", "垂直轴线", "水平线"],
  subject: ["单人", "两人", "三人", "多人", "群像", "并立", "并排", "正面", "侧身", "背向", "互不交流", "互动", "无人物", "裸体", "持杖", "撑伞", "农夫", "舞者", "农妇", "并肩"],
  space: ["室内", "室外", "街道", "建筑", "房屋", "纵深", "平面", "长卷", "海", "天空", "前景", "中景", "背景", "湿地面", "雪", "山", "乡村"],
  colorLight: ["漫射", "硬光", "侧光", "逆光", "落日", "平光", "冷", "暖", "低饱和", "高饱和", "明暗", "柔和", "灰", "金"],
};

function extractTokens(text, dim) {
  const t = String(text || "");
  return TOKENS[dim].filter((tok) => t.includes(tok));
}

function tokensOf(profile) {
  const texts = {
    composition: [profile.composition?.skeleton, profile.composition?.position, profile.composition?.weight],
    subject: [profile.subject?.description, profile.subject?.relation, ...(profile.figures || []).map((f) => `${f.pose || ""}${f.facing || ""}${f.relation || ""}`)],
    space: [profile.space?.setting, profile.space?.foreground, profile.space?.midground, profile.space?.background, profile.space?.depthCue],
    colorLight: [profile.colorLight?.dominant, profile.colorLight?.temperature, profile.colorLight?.contrast, profile.colorLight?.direction, profile.colorLight?.quality, profile.colorLight?.organization],
  };
  const out = {};
  for (const dim of DIMENSIONS) out[dim] = [...new Set((texts[dim] || []).flatMap((t) => extractTokens(t, dim)))];
  return out;
}

/** 单图 V2 分析 → 统一画像。 */
function profileFromAnalysis(entryId, analysis, meta) {
  if (!analysis) return null;
  return {
    entryId,
    kind: "single-image-analysis",
    source: meta,
    subject: {
      count: analysis.subject?.count ?? null,
      description: analysis.subject?.description ?? null,
      relation: (analysis.figures || []).map((f) => [f.pose, f.facing, f.relation].filter(Boolean).join("，")).filter(Boolean).join("；") || null,
    },
    figures: analysis.figures || [],
    composition: {
      skeleton: analysis.composition?.skeleton ?? null,
      position: analysis.composition?.subjectPosition ?? null,
      weight: analysis.composition?.visualWeight ?? null,
    },
    space: {
      // 预检存的是扁平 setting（字符串）；V2 完整结构则在 scene.setting
      setting: analysis.scene?.setting ?? analysis.setting ?? null,
      foreground: analysis.space?.foreground ?? null,
      midground: analysis.space?.midground ?? null,
      background: analysis.space?.background ?? null,
      depthCue: analysis.space?.depthCue ?? null,
    },
    colorLight: {
      dominant: analysis.color?.dominant ?? null,
      temperature: analysis.color?.temperature ?? null,
      contrast: analysis.color?.contrast ?? null,
      direction: analysis.light?.direction ?? null,
      quality: analysis.light?.quality ?? null,
      organization: analysis.light?.organization ?? null,
    },
    transferable: (analysis.transferable || []).map((t) => t.method).filter(Boolean),
    differences: [],
    tokens: null,
  };
}

/** 多图比较里某个候选的判定 → 画像（只含模型实际给出的字段）。 */
function profileFromJudgment(entryId, judgment, meta) {
  if (!judgment) return null;
  const p = {
    entryId,
    kind: "comparison-judgment",
    source: meta,
    subject: {
      count: null,
      description: null,
      relation: judgment.subjectRelationEvidence || judgment.figureOrganization || null,
    },
    figures: [],
    composition: {
      skeleton: judgment.compositionEvidence ?? null,
      position: null,
      weight: null,
    },
    space: {
      setting: null, foreground: null, midground: null, background: null,
      depthCue: judgment.borrowableSpace ?? null,
    },
    colorLight: {
      dominant: judgment.colorLightEvidence ?? null,
      temperature: null, contrast: null,
      direction: judgment.borrowableLight ?? null,
      quality: null, organization: judgment.borrowableColor ?? null,
    },
    transferable: judgment.borrowableForCreation ? [judgment.borrowableForCreation] : [],
    differences: judgment.majorDifferences || [],
    tokens: null,
  };
  p.tokens = tokensOf(p);
  return p;
}

/**
 * 从一组比较判定的「差异」文本反推查询画面特征。
 * 例：「候选为室内场景，无街道与湿地面反光」→ 查询有 街道、湿地面。
 * 必须标 derived：这是从候选侧反推的，可信度低于直接分析。
 */
function deriveQueryProfile(queryEntryId, judgments, meta) {
  const texts = [];
  for (const j of judgments) {
    texts.push(...(j.majorDifferences || []));
    texts.push(...(j.similarPoints || []));
    if (j.compositionEvidence) texts.push(j.compositionEvidence);
    if (j.colorLightEvidence) texts.push(j.colorLightEvidence);
    if (j.subjectRelationEvidence) texts.push(j.subjectRelationEvidence);
  }
  const p = {
    entryId: queryEntryId,
    kind: "derived-query",
    source: meta,
    subject: { count: null, description: null, relation: null },
    figures: [],
    composition: { skeleton: null, position: null, weight: null },
    space: { setting: null, foreground: null, midground: null, background: null, depthCue: null },
    colorLight: { dominant: null, temperature: null, contrast: null, direction: null, quality: null, organization: null },
    transferable: [],
    differences: texts,
    tokens: null,
  };
  // token 必须直接从差异文本提，不能走 tokensOf（那个只读画像字段，而这里字段全空）
  p.tokens = {};
  for (const dim of DIMENSIONS) {
    p.tokens[dim] = [...new Set(texts.flatMap((t) => extractTokens(t, dim)))];
  }
  // 反推画像的 token 全部来自差异文本；若某个维度一个词都没有，就置空
  for (const dim of DIMENSIONS) {
    if (!p.tokens[dim].length) {
      if (dim === "composition") p.composition = { skeleton: null, position: null, weight: null };
      if (dim === "colorLight") p.colorLight = { dominant: null, temperature: null, contrast: null, direction: null, quality: null, organization: null };
    }
  }
  return p;
}

/**
 * 构建语义画像表。
 * @returns {{profiles: Map, derivedQueries: Map, stats: object}}
 */
export function buildSemanticTable({ cacheDir, statePath, fixturesPath }) {
  const profiles = new Map();
  const derivedQueries = new Map();
  const stats = { cacheEntries: 0, comparisonEntries: 0, candidateProfiles: 0, queryAnalyses: 0, derivedQueries: 0, skippedMock: 0, attributed: 0 };

  // 0) 归因表：callId → 查询 id（来自固定夹具，不猜）
  let attribution = {};
  if (fixturesPath) {
    try {
      const fx = JSON.parse(fs.readFileSync(fixturesPath, "utf8"));
      attribution = fx.attribution || {};
    } catch { /* 没有夹具就少归因，不崩 */ }
  }

  // 1) 单图 V2 分析（预检）
  try {
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    // 预检把分析结果扁存成 results.A（无 .analysis 包装），两种形状都要认
    const a = state?.results?.A;
    const analysis = a?.analysis || (a && a.ok ? a : null);
    if (analysis) {
      let qid = a.entryId || null;
      if (!qid && fixturesPath) {
        try { qid = JSON.parse(fs.readFileSync(fixturesPath, "utf8"))?.preflight?.A || null; } catch { /* 无夹具 */ }
      }
      const p = profileFromAnalysis(qid || "american-gothic", analysis, {
        kind: "single-image-analysis", model: "deepseek-flash", promptVersion: "p415-v2.2", callId: "preflight-A2",
      });
      if (p) { profiles.set(p.entryId, p); stats.queryAnalyses++; }
    }
  } catch { /* 没有预检状态就少一条，不崩 */ }

  // 2) 真实多图比较缓存
  let files = [];
  try { files = fs.readdirSync(cacheDir).filter((f) => f.endsWith(".json")); } catch { files = []; }
  for (const f of files) {
    stats.cacheEntries++;
    let rec;
    try { rec = JSON.parse(fs.readFileSync(path.join(cacheDir, f), "utf8")); } catch { continue; }
    const payload = rec.payload;
    if (!payload?.ok || payload.mock === true) { stats.skippedMock++; continue; }
    stats.comparisonEntries++;
    const meta = {
      kind: "comparison-judgment", model: rec.model || payload.model,
      promptVersion: rec.promptVersion, callId: rec.callId, at: rec.createdAt,
    };
    const cands = rec.meta?.candidates || [];
    (payload.judgments || []).forEach((j, i) => {
      const id = cands[i];
      if (!id) return;
      const p = profileFromJudgment(id, j, meta);
      if (p && (p.composition.skeleton || p.subject.relation || p.colorLight.dominant)) {
        profiles.set(id, p);
        stats.candidateProfiles++;
      }
    });
    // 查询归因：夹具里有 callId → 查询 id 的映射，才敢反推查询画像
    const qid = attribution[rec.callId]?.queryId;
    derivedQueries.set(rec.callId, { judgments: payload.judgments || [], meta, profile: null, queryId: qid || null });
    stats.derivedQueries++;
    if (qid) {
      const qp = deriveQueryProfile(qid, payload.judgments || [], meta);
      // 已有真实单图分析的查询不被反推画像覆盖（反推可信度更低）
      const existing = profiles.get(qid);
      if (!existing || existing.kind === "derived-query") profiles.set(qid, qp);
      stats.attributed++;
    }
  }

  // 反推画像的 tokens 是从差异文本里直接提的，不能再按字段重推一遍
  for (const p of profiles.values()) {
    if (p.kind !== "derived-query" || !p.tokens) p.tokens = tokensOf(p);
  }
  return { profiles, derivedQueries, stats };
}

/** 把某个缓存比较的查询 id 指认给反推画像（保留兼容旧调用）。 */
export function attachDerivedQuery(table, callId, queryEntryId) {
  const d = table.derivedQueries.get(callId);
  if (!d) return null;
  const p = deriveQueryProfile(queryEntryId, d.judgments, d.meta);
  table.derivedQueries.set(callId, { ...d, profile: p });
  if (queryEntryId) table.profiles.set(queryEntryId, p);
  return p;
}

/**
 * 语义发现：查询画像 vs 候选画像，按维度求交集。
 * 命中条件：≥2 个维度有共同可核对词。返回命中与证据。
 */
export function semanticDiscover(queryProfile, candidateProfiles) {
  if (!queryProfile || !queryProfile.tokens) return { hits: [], skipped: "查询没有语义画像" };
  const hits = [];
  for (const [id, cProf] of candidateProfiles) {
    if (id === queryProfile.entryId) continue;
    if (!cProf || !cProf.tokens) continue;
    const dims = [];
    const evidence = [];
    for (const dim of DIMENSIONS) {
      const shared = queryProfile.tokens[dim].filter((t) => cProf.tokens[dim].includes(t));
      if (shared.length) {
        dims.push(dim);
        evidence.push({ dim, tokens: shared, queryText: queryProfile.tokens[dim].join("、"), candidateText: cProf.tokens[dim].join("、") });
      }
    }
    if (dims.length >= 2) {
      hits.push({
        id, matchedDimensions: dims, score: dims.length,
        evidence,
        priority: ["composition", "subject", "space", "colorLight"].map((d) => dims.indexOf(d)).filter((x) => x >= 0),
      });
    }
  }
  hits.sort((a, b) => b.matchedDimensions.length - a.matchedDimensions.length);
  return { hits, skipped: null };
}

/** 候选是否有可信画像（没有就标 unanalyzed）。 */
export function hasProfile(table, id) {
  return table.profiles.has(id);
}
