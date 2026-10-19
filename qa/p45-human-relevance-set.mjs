// P4.5 STEP 3 — 人工相关性标准集
//
// 目的：用「人类判断」而非「测试全 PASS」来评价检索质量。
// 每个用例标注：期望命中的作品、必须不出现的错误召回、以及为什么这样判断。
//
// 六类查询（任务书要求全部覆盖）：
//   exact      精确作品检索
//   visual     纯视觉结构
//   color      色彩主导
//   subject    艺术题材
//   culture    文化与艺术传统
//   negative   确实不存在对应作品的反例

export const HUMAN_RELEVANCE_SET = [
  // ---------- 1. 精确作品检索 ----------
  {
    id: "exact-01",
    type: "exact",
    query: "宫娥",
    expectTop: ["meninas"],
    mustNotRank1: [],
    rationale: "中文作品名直接检索，应精确命中该作且排第一。若返回其它宫廷群像即为失败。",
  },
  {
    id: "exact-02",
    type: "exact",
    query: "1808年5月3日",
    expectTop: ["third-of-may"],
    mustNotRank1: [],
    rationale: "日期式作品名（别名），检验 aliasesZh 是否生效。",
  },
  {
    id: "exact-03",
    type: "exact",
    query: "惠斯勒的母亲",
    expectTop: ["whistlers-mother"],
    mustNotRank1: [],
    rationale: "俗称检索。正式标题是「灰与黑的协奏曲」，只有别名能命中。",
  },

  // ---------- 2. 纯视觉结构 ----------
  {
    id: "visual-01",
    type: "visual",
    query: "雾 空旷",
    expectTop: ["monk-by-sea", "xia-gui-streams", "wanderer"],
    mustNotRank1: ["film-city-lights"],
    rationale: "大留白+深纵远的视觉结构。城市夜景不应排第一。",
  },
  {
    id: "visual-02",
    type: "visual",
    query: "孤独 夜晚",
    expectTop: ["starry", "bar-folies"],
    mustNotRank1: [],
    rationale: "夜景+孤立感。检验情绪与明暗结构是否共同作用。",
  },
  {
    id: "visual-03",
    type: "visual",
    query: "人群",
    expectTop: [],
    expectAny: ["jatte", "night-watch", "meninas"],
    mustNotRank1: [],
    rationale: "多人密集场景。至少应出现一件确实有多人的作品，而不是单人群像。",
  },

  // ---------- 3. 色彩主导 ----------
  {
    id: "color-01",
    type: "color",
    query: "雪",
    expectAny: ["impression-sunrise", "hunters-snow", "wanderer"],
    mustNotRank1: [],
    rationale: "雪=冷色低饱和散射光。若首条是暖色高饱和作品则为失败。",
  },
  {
    id: "color-02",
    type: "color",
    query: "夜晚",
    expectAny: ["starry", "night-watch"],
    mustNotRank1: [],
    rationale: "夜景=低明度高对比。",
  },

  // ---------- 4. 艺术题材 ----------
  {
    id: "subject-01",
    type: "subject",
    query: "战争",
    expectAny: ["third-of-may"],
    mustNotRank1: [],
    rationale: "档案中只有《1808年5月3日》是明确的历史战争题材（Wikidata genre=history painting）。",
  },
  {
    id: "subject-02",
    type: "subject",
    query: "肖像",
    expectAny: ["whistlers-mother"],
    mustNotRank1: [],
    rationale: "Wikidata genre=portrait 的作品。如把静物/风景也算作肖像即为错误召回。",
  },
  {
    id: "subject-03",
    type: "subject",
    query: "宗教",
    expectAny: ["calling"],
    mustNotRank1: [],
    rationale: "Wikidata genre=religious art。不应把神话或历史画混入。",
  },
  {
    id: "subject-04",
    type: "subject",
    query: "室内",
    expectAny: ["milkmaid", "meninas", "bar-folies"],
    mustNotRank1: [],
    rationale: "三件室内场景。检验是否会漏召回（P4.4 只命中 1 件）。",
  },

  // ---------- 5. 文化与艺术传统 ----------
  {
    id: "culture-01",
    type: "culture",
    query: "日本",
    expectAny: ["wave", "hiroshige-shower", "utamaro-three-beauties"],
    mustNotRank1: [],
    rationale: "日本传统作品。中文「日本」应走文化路径，不得被曲解成构图特征。",
  },
  {
    id: "culture-02",
    type: "culture",
    query: "中国",
    expectAny: ["fuchun-mountains", "fan-kuan-travelers", "guo-xi-early-spring"],
    mustNotRank1: [],
    rationale: "中国画传统。",
  },

  // ---------- 6. 反例：确实不存在 ----------
  {
    id: "negative-01",
    type: "negative",
    query: "静物",
    expectAny: [],
    mustBeEmpty: true,
    rationale: "档案中无一件 Wikidata genre=still life。正确行为是返回空并说明，而不是拿水果/餐具充数。",
  },
  {
    id: "negative-02",
    type: "negative",
    query: "量子纠缠",
    expectAny: [],
    mustBeEmpty: true,
    rationale: "完全无关的概念。任何非空结果都是错误召回。",
  },
  {
    id: "negative-03",
    type: "negative",
    query: "恐龙",
    expectAny: [],
    mustBeEmpty: true,
    rationale: "档案中不存在恐龙题材。",
  },
];

/**
 * 评价一条结果：返回人类可读的判定，而不是简单布尔。
 * @param {object} spec   用例
 * @param {Array} results 检索结果（含 artwork.id / basis / retrievalScore / matchedFields）
 */
export function judgeCase(spec, results) {
  const ids = results.map((r) => r.artwork.id);
  const top1 = ids[0] || null;
  const notes = [];
  let verdict = "pass";

  if (spec.mustBeEmpty) {
    if (ids.length === 0) {
      notes.push("按要求返回空结果（正确）");
    } else {
      verdict = "fail";
      notes.push(`应为空却返回 ${ids.length} 条：${ids.slice(0, 3).join(", ")}`);
    }
    return { id: spec.id, type: spec.type, query: spec.query, verdict, top1, ids, notes };
  }

  // 精确 / 题材 / 文化：必须命中指定集合中的至少一件
  const required = spec.expectTop || spec.expectAny || [];
  if (required.length) {
    const hit = required.filter((x) => ids.includes(x));
    if (!hit.length) {
      verdict = "fail";
      notes.push(`期望命中 ${required.join("/")}，实际一条都没有`);
    } else {
      notes.push(`命中 ${hit.join(", ")}（期望集合 ${required.length} 件中 ${hit.length} 件）`);
      if (spec.expectTop) {
        if (spec.expectTop.includes(top1)) notes.push("且排第一（正确）");
        else {
          verdict = verdict === "fail" ? "fail" : "weak";
          notes.push(`但首条是 ${top1}，不是期望的精确作品`);
        }
      }
    }
  }

  // 错误召回
  if (spec.mustNotRank1 && spec.mustNotRank1.includes(top1)) {
    verdict = "fail";
    notes.push(`禁止排第一的 ${top1} 却在首位`);
  }

  // 空结果但期望应有内容
  if (!required.length && !ids.length) {
    verdict = "weak";
    notes.push("返回空，但用例未指定期望集合，无法判定是否合理");
  }

  return { id: spec.id, type: spec.type, query: spec.query, verdict, top1, ids: ids.slice(0, 5), notes };
}
