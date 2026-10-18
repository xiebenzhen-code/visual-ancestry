// visualAssistant — Personal Visual Assistant 薄层 (P5.6).
//
// 组合层，不是能力层：本文件 ZERO 重实现 —— 只调用冻结的
//   visualProfile (画像) / retrieveVisualMemory (检索) / memoryRepository (资产)。
// 三个任务：
//   understand_taste  → 画像统计 → summary + evidence（强制携带 sampleSize/confidence）
//   find_reference    → 规则式 NL→VisualQuery → 检索 → 每条带 reason
//   creative_support  → 场景意图 + 个人画像 + 检索 → Creative Brief（引用个人记忆，非 AI 创作）
//
// Agent 边界（P5.6 设计纪律，QA 固定）：
//   ❌ 无 Agent Loop / 无自主规划 / 无联网 / 无 LLM 调用 / 无聊天窗口 / 无自动导演 / 不替用户决策
//   ❌ 永不输出：审美等级 / 人格判断 / 「比别人高级」/ 推荐喜好
//   ✅ 「理解」= 规则映射 + 冻结画像；「寻找」= 冻结检索；「辅助」= 个人记忆的结构化整理
//   ✅ 每条输出可追溯：证据计数 / matchedFields / reasons / 样本量
//
// 自然语言映射是**规则式**的（关键词→schema 枚举），不是意图识别模型：
// 未映射的词诚实收集进 unmapped 并明示，不假装理解。

import { buildVisualProfile } from "./visualProfile.js";
import { retrieveVisualMemory } from "./retrieveVisualMemory.js";
import { listMemories } from "./memoryRepository.js";

// 与冻结 presenter 相同的语气纪律（该文件常量未导出，此处按同一阈值复刻并注明）
const STRONG = 0.55; // ≥55% → 「经常/倾向」
const WEAK = 0.4; // 40–55% → 「接近半数」；<40% → 不作主张

export const TASKS = ["understand_taste", "find_reference", "creative_support"];

// ---- 规则式 NL→VisualQuery 映射（schema 真实枚举，零幻觉空间）--------------
const RULES = [
  [/孤独|孤立|独自|一个人|孤身/, "humanRelation", "isolated"],
  [/人群|群像|多人|拥挤/, "humanRelation", "crowd"],
  [/相伴|成双/, "humanRelation", "together"],
  [/疏离|距离很远|人际距离/, "socialDistance", "high"],
  [/巨大环境|环境主导|环境压过|宏大自然/, "environmentDominance", "high"],
  [/留白|负空间|空旷|荒原|旷野/, "negativeSpace", "high"],
  [/深空间|纵深|深远|景深/, "spatialDepth", "deep"],
  [/浅空间|扁平/, "spatialDepth", "shallow"],
  [/低饱和|素净|灰调/, "saturation", "low"],
  [/高饱和|艳丽|浓郁/, "saturation", "high"],
  [/冷色|冷调|清冷/, "colorTemperature", "cool"],
  [/暖色|暖调|温暖/, "colorTemperature", "warm"],
  [/高对比|对比强烈|明暗对比/, "contrast", "high"],
  [/低对比|柔和的明暗/, "contrast", "low"],
  [/柔光|柔和的光|散射光/, "lightQuality", "diffuse"],
  [/硬光|直射光/, "lightQuality", "directional"],
  [/逆光|轮廓光/, "lightDirection", "back"],
  [/远景|远距离/, "cameraDistance", "far"],
  [/近景|特写/, "cameraDistance", "near"],
  [/静止|安静的画面|不动/, "motion", "still"],
  [/动态|运动|流动/, "motion", "moving"],
  [/稀疏|极简/, "visualDensity", "sparse"],
  [/密集|信息量大/, "visualDensity", "dense"],
  [/低唤醒|静谧|平静/, "arousal", "low"],
  [/忧郁|惆怅|哀伤/, "melancholy", "medium"],
];

// 氛围/情绪是 token 列表字段（冻结 ATMOSPHERE_TOKENS 词表）
const ATMOSPHERE_RULES = [
  [/空旷|荒原|旷野|辽阔/, "空旷"],
  [/寂静|安静|无声|静谧/, "寂静"],
  [/夜晚|夜色|深夜|夜景/, "夜晚"],
  [/雾|薄雾|迷雾/, "雾"],
  [/热闹|喧嚣|繁华/, "热闹"],
  [/阴郁|阴沉|灰暗/, "阴郁"],
];

export function mapQueryFromText(text) {
  const raw = String(text || "");
  const query = {};
  const atmosphere = new Set();
  let rest = raw;
  const absorb = (matched) => {
    rest = rest.replace(matched, " ");
  };
  for (const [re, field, value] of RULES) {
    const m = raw.match(re);
    if (m && query[field] === undefined) {
      query[field] = value;
      absorb(m[0]);
    }
  }
  for (const [re, token] of ATMOSPHERE_RULES) {
    const m = raw.match(re);
    if (m) {
      atmosphere.add(token);
      absorb(m[0]);
    }
  }
  if (atmosphere.size) query.atmosphere = [...atmosphere];

  // 未映射片段：诚实收集（去虚词后 ≥2 字的剩余段）
  const unmapped = rest
    .split(/[\s，,。、；;的想找一些感觉参考帮我我我要做设计生成一个场景镜头作品风格喜欢看看]/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);

  return { query, unmapped };
}

// ---- helpers ---------------------------------------------------------------

const GROUP_LABELS = {
  spatial: { deepSpace: "深空间", environmentDominant: "环境主导构图", negativeSpaceHigh: "大量留白" },
  composition: { centeredSubject: "主体居中", farCamera: "远景镜头", staticFrame: "静止画面" },
  color: { lowSaturation: "低饱和", neutralTone: "中性色温", coolTone: "冷色", warmTone: "暖色", highContrast: "高对比" },
  narrative: { isolation: "孤立人物", socialDistanceHigh: "人际疏离", quietArousal: "静谧低唤醒", melancholyMedium: "忧郁基调" },
};

function tendencyLines(profile) {
  const lines = [];
  for (const [group, fields] of Object.entries(GROUP_LABELS)) {
    for (const [key, label] of Object.entries(fields)) {
      const s = profile[group] && profile[group][key];
      if (!s || !s.count) continue;
      if (s.ratio >= STRONG) lines.push({ group, key, label, count: s.count, ratio: s.ratio, tone: "strong" });
      else if (s.ratio >= WEAK) lines.push({ group, key, label, count: s.count, ratio: s.ratio, tone: "weak" });
      // <0.40 → 不作主张（与 presenter 同纪律）
    }
  }
  return lines.sort((a, b) => b.ratio - a.ratio);
}

function evidenceLine(line) {
  const pct = Math.round(line.ratio * 100);
  const tone = line.tone === "strong" ? "经常出现" : "接近半数";
  return `${line.label} ${tone}（${line.count}/${line.sampleSize ?? ""} · ${pct}%）`;
}

const MEDIUM = (m) => (m.metadata && m.metadata.origin === "film-still" ? "film" : "painting");

function toResult(evidence) {
  const m = evidence.memory || {};
  return {
    id: evidence.id,
    title: (m.metadata && m.metadata.title) || "未命名素材",
    image: (m.userData && m.userData.thumbnail) || (m.image && m.image.path) || "",
    medium: MEDIUM(m),
    reason: evidence.reasons || [],
    matchedFields: evidence.matchedFields || [],
    score: Number.isFinite(evidence.score) ? Number(evidence.score.toFixed(1)) : 0,
  };
}

// ---- Task 1: Understand My Taste -------------------------------------------

export async function understandTaste() {
  const profile = await buildVisualProfile();
  const lines = tendencyLines(profile).map((l) => ({ ...l, sampleSize: profile.sampleSize }));
  const strong = lines.filter((l) => l.tone === "strong");
  const weak = lines.filter((l) => l.tone === "weak");

  let summary;
  if (profile.sampleSize === 0) {
    summary = "还没有足够的视觉记忆——先收藏几张素材，我才能诚实地总结倾向。";
  } else if (!strong.length && !weak.length) {
    summary = `当前 ${profile.sampleSize} 条收藏中没有 ≥40% 的共同倾向，暂不总结，避免以偏概全。`;
  } else {
    const parts = strong.slice(0, 3).map((l) => l.label);
    summary = `你的收藏倾向于${parts.join("、")}`;
    if (weak.length) summary += `；${weak[0].label}也接近半数`;
    summary += `。基于 ${profile.sampleSize} 条视觉记忆的统计，不是审美评价。`;
  }

  return {
    task: "understand_taste",
    ok: profile.sampleSize > 0,
    summary,
    evidence: lines.map(evidenceLine),
    sampleSize: profile.sampleSize,
    confidence: profile.confidence,
    unavailable: profile.unavailable || {},
  };
}

// ---- Task 2: Find My References --------------------------------------------
// 两段式检索（全部走冻结 retrieveVisualMemory，零重实现）：
//   1) 场景语言原样检索；
//   2) 零命中时的「个人倾向补全」：冻结 sharedReasons 标签表不含
//      humanRelation/colorTemperature 等字段，纯这类查询会被冻结过滤规则
//      正确地拒收（无可解释理由）——此时用用户自己的高频倾向（仅限
//      reason-labeled 字段）补全查询并明示。补全来自个人画像，不引入外部语义。
const ENRICHABLE = [
  ["spatial", "deepSpace", "spatialDepth", "deep"],
  ["spatial", "environmentDominant", "environmentDominance", "high"],
  ["color", "lowSaturation", "saturation", "low"],
  ["composition", "staticFrame", "motion", "still"],
  ["spatial", "negativeSpaceHigh", "negativeSpace", "high"],
];

export async function findReference(query, { limit = 5 } = {}) {
  const { query: visualQuery, unmapped } = mapQueryFromText(query);
  const mappedCount = Object.keys(visualQuery).length;
  if (!mappedCount) {
    return {
      task: "find_reference",
      ok: false,
      query,
      message: "无法从这句话中提取视觉语言——试试提到空间（深空间/留白）、色彩（低饱和/冷色）或人物（孤独/人群）。",
      results: [],
      unmapped,
    };
  }
  const profile = await buildVisualProfile();
  let hits = await retrieveVisualMemory(visualQuery, { limit });
  let enriched = null;
  if (!hits.length && profile.sampleSize > 0) {
    enriched = {};
    for (const [group, key, field, value] of ENRICHABLE) {
      const s = profile[group] && profile[group][key];
      if (s && s.ratio >= WEAK) { enriched[field] = value; if (Object.keys(enriched).length >= 2) break; }
    }
    if (Object.keys(enriched).length) {
      hits = await retrieveVisualMemory({ ...visualQuery, ...enriched }, { limit });
    }
  }
  return {
    task: "find_reference",
    ok: true,
    query,
    visualQuery,
    enrichedQuery: enriched,
    results: hits.map(toResult),
    total: hits.length,
    unmapped,
    note: hits.length
      ? (enriched ? "场景语言无可解释命中，已按你的高频视觉倾向补全检索（enrichedQuery 如实展示）。" : undefined)
      : "个人记忆中没有与这组视觉语言匹配的资产——如实返回，不强行推荐。",
  };
}

// ---- Task 3: Assist My Creation --------------------------------------------

export async function creativeSupport(query, { limit = 6 } = {}) {
  const { query: sceneQuery, unmapped } = mapQueryFromText(query);
  const profile = await buildVisualProfile();

  if (profile.sampleSize === 0) {
    return {
      task: "creative_support",
      ok: false,
      query,
      message: "个人记忆为空——没有足够的参考来支撑创作辅助，我不会编造方向。",
      direction: null,
      references: [],
      basedOn: { sampleSize: 0, confidence: profile.confidence },
      unmapped,
    };
  }

  const lines = tendencyLines(profile).map((l) => ({ ...l, sampleSize: profile.sampleSize }));
  const pick = (group) => lines.filter((l) => l.group === group).slice(0, 2)
    .map((l) => `${l.label}（${Math.round(l.ratio * 100)}%）`);

  // 检索：优先用户场景语言；若场景语言无可解释命中（冻结 sharedReasons
  // 标签表不含 humanRelation 等），合并用户高频倾向补全——全部走冻结检索
  let hits = [];
  let usedQuery = sceneQuery;
  if (Object.keys(sceneQuery).length) {
    hits = await retrieveVisualMemory(sceneQuery, { limit });
  }
  if (!hits.length) {
    const fallback = {};
    if (profile.spatial.deepSpace.ratio >= WEAK) fallback.spatialDepth = "deep";
    if (profile.color.lowSaturation.ratio >= WEAK) fallback.saturation = "low";
    if (profile.spatial.environmentDominant.ratio >= WEAK) fallback.environmentDominance = "high";
    if (Object.keys(fallback).length) {
      usedQuery = { ...sceneQuery, ...fallback };
      hits = await retrieveVisualMemory(usedQuery, { limit });
    }
  }

  return {
    task: "creative_support",
    ok: true,
    query,
    sceneQuery,
    direction: {
      space: pick("spatial"),
      composition: pick("composition"),
      color: pick("color"),
      narrative: pick("narrative"),
    },
    sceneLanguage: sceneQuery,
    references: hits.map(toResult),
    basedOn: { sampleSize: profile.sampleSize, confidence: profile.confidence },
    unmapped,
    note: "以上方向全部来自你自己的收藏统计与历史参考——不是 AI 创作，最终决策在你。",
  };
}

// ---- dispatch ---------------------------------------------------------------

export async function runAssistant({ task, query, context } = {}) {
  if (!TASKS.includes(task)) {
    return { ok: false, message: `未知任务类型（支持：${TASKS.join(" / ")}）` };
  }
  if (task === "understand_taste") return understandTaste();
  if (task === "find_reference") return findReference(query, context);
  return creativeSupport(query, context);
}

// 供 QA/统计使用：当前个人记忆池规模（只读组合，不另立数据通道）
export async function poolSize() {
  const all = await listMemories();
  return all.filter((m) => m.status === "success").length;
}
