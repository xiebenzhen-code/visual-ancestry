// P4.4 STEP 2 — 常见查询的词表扩展与「主题/文化」回退
//
// 设计边界（写进代码，不是只写在注释里）：
//
//   A. 视觉描述  → 可映射到 VisualIntent（subject / scale / depth / light …）
//   B. 作品题材  → 不是视觉结构。单列 subjectTerms，用于文本/元数据检索，
//                  绝不写进 emotion / atmosphere / composition
//   C. 文化地区  → 不是构图特征。单列 cultureTerms，只用于元数据匹配
//   D. 仅元数据  → 只能靠关键词查找
//
// 硬规则：
//   · 「战争」不得被解释成任何情绪或光位
//   · 「日本」不得被伪装成构图/景深特征
//   · 匹配不到就返回空 + 原因，不为凑非空而填充无关作品
//
// 本模块是**纯函数**，不读网络、不读磁盘。

import { emptyVisualIntent, mergeIntent } from "./visualIntent.js";
import { ART_SEMANTICS } from "../../data/art-semantics.js";

/**
 * 词汇分类表。每条必须是四类之一，并标明依据。
 *   kind: "visual" | "subject" | "culture" | "metadata"
 *   patch: 仅 kind==="visual" 时携带 VisualIntent 补丁（值必须来自合法枚举）
 */
export const QUERY_LEXICON = [
  // ---------- A. 视觉描述（真能进 VisualIntent）----------
  {
    id: "war-visual",
    kind: "visual",
    terms: ["战场", "战斗场面", "冲锋", "硝烟", "士兵冲锋", "battlefield", "charging soldiers"],
    // 只描述「画面里能看到的人群与空间」，不描述情绪
    patch: { subject: "group", socialDistance: "low", visualDensity: "dense", motion: "moving" },
    rationale: "画面层面：多人密集、动作中。不涉及战争的情绪含义。",
  },
  {
    id: "portrait-visual",
    kind: "visual",
    terms: ["正面半身像", "人物特写", "大头像", "face fills frame", "head and shoulders"],
    patch: { subject: "portrait", subjectScale: "large", cameraDistance: "near" },
    rationale: "可观察的构图事实：主体是脸/半身，占画面大。",
  },
  {
    id: "interior-visual",
    kind: "visual",
    terms: ["室内空间", "屋里", "房间内", "indoor room", "inside a room"],
    patch: { environmentDominance: "high", spatialDepth: "shallow" },
    rationale: "可观察：环境包住主体、纵深浅。",
  },
  {
    id: "city-visual",
    kind: "visual",
    terms: ["城市街道", "街道", "马路", "城市", "street scene", "city street", "city"],
    patch: { environmentDominance: "high", visualDensity: "dense", subject: "place" },
    rationale: "可观察：环境主导、信息密集、主体是场所。",
  },
  {
    id: "snow-visual",
    kind: "visual",
    terms: ["雪景", "下雪", "积雪", "雪", "snow scene", "snowy", "snow"],
    patch: { colorTemperature: "cool", saturation: "low", contrast: "low", lightQuality: "diffuse" },
    rationale: "可观察：冷色、低饱和、散射光。不含「冬」的文化联想。",
  },
  {
    id: "crowd-visual",
    kind: "visual",
    terms: ["人群", "一群人", "很多人", "crowd", "many people"],
    patch: { subject: "group", humanRelation: "crowd", socialDistance: "low", visualDensity: "dense" },
    rationale: "可观察：多人、拥挤、密度高。",
  },
  {
    id: "sea-visual",
    kind: "visual",
    terms: ["海面", "大海", "海洋", "海", "seascape", "open sea", "sea"],
    patch: { environmentDominance: "high", spatialDepth: "deep", negativeSpace: "high" },
    rationale: "可观察：环境主导、纵深远、留白多。",
  },

  // ---------- B. 作品题材 / 类型（不是视觉结构）----------
  {
    id: "war-subject",
    kind: "subject",
    terms: ["战争", "战役", "战斗", "war", "battle"],
    // 刻意不提供 patch
    matchFields: ["title", "titleZh", "titleEn", "visualDNA", "narrativeFunction", "oneLine"],
    rationale: "「战争」是题材标签。同一题材可以是阳光下的静物，无法推定画面结构或情绪。",
  },
  {
    id: "portrait-subject",
    kind: "subject",
    terms: ["肖像", "画像", "portrait"],
    matchFields: ["title", "titleZh", "titleEn"],
    rationale: "「肖像」是作品类型名，不等于画面一定是近景大头部。",
  },
  {
    id: "stilllife-subject",
    kind: "subject",
    terms: ["静物", "still life"],
    matchFields: ["title", "titleZh", "titleEn"],
    rationale: "「静物」是体裁名；其画面结构（平铺/纵深）差异很大。",
  },
  {
    id: "interior-subject",
    kind: "subject",
    terms: ["室内", "interior"],
    matchFields: ["title", "titleZh", "titleEn", "spatialStructure"],
    rationale: "「室内」可能指题材也可能指空间，仅作题材检索更诚实。",
  },
  {
    id: "religious-subject",
    kind: "subject",
    terms: ["宗教", "圣像", "圣母", "基督", "佛", "菩萨", "religion", "religious", "madonna", "buddha"],
    matchFields: ["title", "titleZh", "titleEn", "narrativeFunction", "oneLine"],
    rationale: "「宗教」是题材，不推定画面结构。",
  },

  // ---------- C. 文化 / 地区 / 传统（不是构图特征）----------
  {
    id: "japan-culture",
    kind: "culture",
    terms: ["日本", "日式", "浮世绘", "japan", "japanese", "ukiyo-e"],
    cultureTokens: ["japan", "japanese"],
    matchFields: ["origin", "culture", "traditions", "museum", "title", "titleZh", "titleEn"],
    rationale: "「日本」是产地/传统。把它当成构图特征会造假——日本画既有满密也有大留白。",
  },
  {
    id: "china-culture",
    kind: "culture",
    terms: ["中国", "国画", "水墨", "china", "chinese", "ink painting"],
    cultureTokens: ["china", "chinese"],
    matchFields: ["origin", "culture", "traditions", "museum", "title", "titleZh", "titleEn"],
    rationale: "同上：文化归类不等于视觉结构。",
  },
];

/** 所有能被视觉规则消费的条目 */
const VISUAL_RULES = QUERY_LEXICON.filter((e) => e.kind === "visual");
/** 主题/文化条目（用于文本回退检索） */
const TEXT_ENTRIES = QUERY_LEXICON.filter((e) => e.kind === "subject" || e.kind === "culture");

/** 找到命中的词条（一个查询可能命中多条） */
export function matchLexicon(text) {
  const s = String(text || "");
  const hits = [];
  for (const entry of QUERY_LEXICON) {
    const term = entry.terms.find((t) => s.toLowerCase().includes(String(t).toLowerCase()));
    if (term) hits.push({ entry, term });
  }
  return hits;
}

/**
 * 只做视觉部分：把 kind==="visual" 的命中合并进 VisualIntent。
 * 返回 { intent, visualHits }。绝不把 subject/culture 写进 intent。
 */
export function applyVisualLexicon(intent, text) {
  const hits = matchLexicon(text);
  const visual = hits.filter((h) => h.entry.kind === "visual");
  let next = intent;
  const atmospheres = new Set(next.atmosphere || []);
  for (const h of visual) {
    const patch = { ...h.entry.patch };
    if (patch.atmosphere) {
      patch.atmosphere.forEach((a) => atmospheres.add(a));
      delete patch.atmosphere;
    }
    next = mergeIntent(next, patch);
  }
  next.atmosphere = [...atmospheres];
  return { intent: next, visualHits: visual.map((h) => ({ id: h.entry.id, term: h.term, rationale: h.entry.rationale })) };
}

/**
 * 文本回退检索：主题词 / 文化词对作品的文本字段做关键词匹配。
 * 明确返回 matchedFields，便于界面说明「这是文本匹配，不是视觉相似」。
 */
export function searchByLexicon(artworks, text) {
  const hits = matchLexicon(text);
  const textEntries = hits.filter((h) => h.entry.kind === "subject" || h.entry.kind === "culture");
  if (!textEntries.length) {
    return { results: [], reason: "no-lexicon-match", matchedTerms: [], perEntry: [] };
  }

  const results = [];
  const perEntry = [];
  for (const { entry, term } of textEntries) {
    let count = 0;
    for (const a of artworks) {
      const matchedFields = [];
      for (const f of entry.matchFields || []) {
        const v = a[f];
        if (v === undefined || v === null) continue;
        const hay = Array.isArray(v) ? v.join(" ") : String(v);
        if (!hay) continue;
        if (hay.toLowerCase().includes(String(term).toLowerCase())) matchedFields.push(f);
        // culture 类额外用 cultureTokens 做归一匹配
        if (entry.cultureTokens && f === "origin") {
          const toks = entry.cultureTokens;
          if (toks.some((t) => hay.toLowerCase().includes(t))) {
            if (!matchedFields.includes(f)) matchedFields.push(f);
          }
        }
      }
      // P4.5 — 语义层主题匹配。这不是「给某几件作品写死排名」，而是：
      //   · 语义数据里带了可追溯的主题词（themes，来源 Wikidata genre/depicts）
      //   · 任何作品只要主题词集合包含该检索词就会被命中
      //   · 匹配依据写入 matchedFields（"semantics:themes"），与视觉依据严格分开
      const sem = ART_SEMANTICS[a.id];
      if (sem && Array.isArray(sem.themes)) {
        const termLc = String(term).toLowerCase();
        const hitTheme = sem.themes.find((t) => String(t).toLowerCase().includes(termLc));
        if (hitTheme) matchedFields.push(`semantics:themes(${hitTheme})`);
      }
      // 中文别名同样参与（「1808年5月3日」「惠斯勒的母亲」这类）
      if (sem && Array.isArray(sem.aliasesZh)) {
        const termLc = String(term).toLowerCase();
        if (sem.aliasesZh.some((x) => String(x).toLowerCase().includes(termLc))) matchedFields.push("semantics:aliasesZh");
      }

      if (matchedFields.length) {
        results.push({
          artwork: a,
          basis: "text-metadata",
          lexeme: term,
          lexiconKind: entry.kind,
          matchedFields,
          note: `文本匹配（${entry.kind === "culture" ? "文化/地区" : "题材"}），非视觉相似`,
        });
        count++;
      }
    }
    perEntry.push({ id: entry.id, term, kind: entry.kind, hits: count, rationale: entry.rationale });
  }

  // 去重（同一作品可能命中多个词条）
  const seen = new Set();
  const deduped = results.filter((r) => {
    const k = r.artwork.key || r.artwork.id;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return {
    results: deduped,
    reason: deduped.length ? "matched" : "matched-no-results",
    matchedTerms: textEntries.map((h) => h.term),
    perEntry,
  };
}

/**
 * 统一入口：给一个查询，说明它被如何理解，以及结果从哪来。
 * 供检索层调用，也供测试直接断言。
 */
export function analyzeQuery(text) {
  const hits = matchLexicon(text);
  const visual = hits.filter((h) => h.entry.kind === "visual");
  const subject = hits.filter((h) => h.entry.kind === "subject");
  const culture = hits.filter((h) => h.entry.kind === "culture");
  return {
    text: String(text || ""),
    visualTerms: visual.map((h) => ({ term: h.term, id: h.entry.id })),
    subjectTerms: subject.map((h) => ({ term: h.term, id: h.entry.id })),
    cultureTerms: culture.map((h) => ({ term: h.term, id: h.entry.id })),
    canProduceVisualIntent: visual.length > 0,
    canProduceTextMatch: subject.length + culture.length > 0,
    // 关键诚实输出：一个查询为何没有视觉结果
    explanation: visual.length
      ? `识别为视觉描述：${visual.map((h) => h.term).join("、")}`
      : subject.length || culture.length
        ? `这是${subject.length ? "题材" : ""}${subject.length && culture.length ? "与" : ""}${culture.length ? "文化/地区" : ""}查询，只能做文本匹配，不产生视觉结构判断`
        : "无法识别为视觉描述或题材/文化词",
  };
}

export { VISUAL_RULES, TEXT_ENTRIES };
