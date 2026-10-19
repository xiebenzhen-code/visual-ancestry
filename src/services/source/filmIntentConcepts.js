// filmIntentConcepts.js — P4.9 STEP 3：从 VisualIntent 生成**有界**的英文检索概念。
//
// 这条路径的定位必须先说清楚，否则很容易被误读成「视觉搜片」：
//
//   它做的是：把 VisualIntent 里**有客观画面依据、且受控词表里有对应词**的枚举值，
//             翻成一个英文检索词，交给现有的 Commons 发现入口做**元数据**检索。
//   它不做的是：从画面推断环境（「浅景深」不等于「室内」）、推断剧情、
//             推断片名、推断导演、推断年份。一个都不做。
//
// 为什么这么窄：22 键 VisualIntent 全是枚举值，没有自由文本。实测《American Gothic》
// 的 intent 里 environmentDominance=low / spatialDepth=shallow / visualDensity=dense，
// 这些**都不能**诚实地映射成 interior / night / city / landscape。硬映射就是把
// 「室内」这种结论编出来。所以本模块对无法映射的字段一律返回 unmapped，并说明原因。
//
// 因此本模块的输出经常是「0 个可用概念」。这不是失败，是如实报告能力边界：
// 当前 VisualIntent 契约里没有足够的环境语义来支撑开放式视觉检索。

// 只收录**画面可指认、且受控词表（filmConceptTerms TERM_RULES）里真实存在**的映射。
// 每条都必须写清依据字段与取值，便于审计时逐条核对。
const FIELD_RULES = [
  {
    field: "subject",
    map: {
      // 多人 → crowd。这是画面里可直接数出来的人数，不是推断。
      group: { term: "crowd", basis: "subject=group（画面有多人）" },
      // 单人没有对应受控词；不硬凑 "portrait"（那是绘画标签，不是电影类目词）。
      single: null,
      // 无人/空景同理。
      none: null,
    },
  },
  {
    field: "cameraDistance",
    map: {
      // 远景只有在环境占主导时才可能是 landscape；单独 far 不足以判定室外。
      // 这里故意留 null，交给下面的组合规则处理。
      far: null,
      medium: null,
      near: null,
    },
  },
];

// 组合规则：需要**两个**字段同时成立才允许发出环境词。
// 这比单字段映射保守，但能避免把「浅空间 + 低环境占比」误判成室内。
const COMBO_RULES = [
  {
    id: "interior-evidence",
    test: (i) => i.spatialDepth === "shallow" && i.environmentDominance === "low" && i.subject !== "none",
    // 注意：这条**不**产出 interior。
    // 浅空间 + 低环境占比在《American Gothic》里是室外农舍前的正面人像。
    // 它只能说明「环境不主导」，不能说明「在室内」。留作反面样例记录。
    term: null,
    why: "浅空间 + 低环境占比既可能是室内也可能是室外正面特写，不足以判定 interior，故不映射",
  },
];

// 受控词表里真实存在的词（与 filmConceptTerms.js 的 TERM_RULES 对齐）。
// 只允许这些词进入远程检索，防止手写词漂移。
const ALLOWED_TERMS = new Set([
  "landscape", "street", "city", "night", "snow", "sea", "forest",
  "mountain", "interior", "desert", "rain", "crowd", "water",
]);

/**
 * 从 VisualIntent 生成检索概念。
 *
 * @returns {{
 *   concepts: Array<{term:string, field:string, value:string, basis:string}>,
 *   unmapped: Array<{field:string, value:string, why:string}>,
 *   supported: boolean,
 *   reason: string
 * }}
 */
export function conceptsFromIntent(intent) {
  const concepts = [];
  const unmapped = [];
  if (!intent || typeof intent !== "object") {
    return { concepts, unmapped, supported: false, reason: "没有可用的 VisualIntent" };
  }

  // 1) 单字段映射
  for (const rule of FIELD_RULES) {
    const value = intent[rule.field];
    if (value === undefined) continue;
    const hit = rule.map[String(value)];
    if (hit && ALLOWED_TERMS.has(hit.term)) {
      concepts.push({ term: hit.term, field: rule.field, value: String(value), basis: hit.basis });
    } else if (hit === null) {
      unmapped.push({
        field: rule.field,
        value: String(value),
        why: "受控词表里没有与该取值对应的英文检索词，不映射",
      });
    }
  }

  // 2) 组合规则（用于记录「为什么某些看似可映射的组合其实不行」）
  for (const combo of COMBO_RULES) {
    try {
      if (combo.test(intent) && combo.term === null) {
        unmapped.push({ field: combo.id, value: "(组合)", why: combo.why });
      }
    } catch { /* 组合条件读不到就不判定 */ }
  }

  // 3) 明确记录「环境类字段无法映射」这件事本身。
  //    这是能力边界，不是缺陷：契约里就没有环境枚举。
  const envFields = ["environmentDominance", "spatialDepth", "visualDensity", "motion"];
  const envPresent = envFields.filter((f) => intent[f] !== undefined);
  if (envPresent.length) {
    unmapped.push({
      field: "environment",
      value: envPresent.map((f) => `${f}=${intent[f]}`).join(", "),
      why:
        "VisualIntent 没有 interior/night/city/landscape 这类环境枚举；" +
        "这些字段只描述空间与密度，不能推出具体场景类型",
    });
  }

  const supported = concepts.length > 0;
  const reason = supported
    ? `从 ${[...new Set(concepts.map((c) => c.field))].join("/")} 得到 ${concepts.length} 个受控概念`
    : "当前 VisualIntent 中没有任何字段能诚实映射为受控检索词（详见 unmapped）";

  return { concepts, unmapped, supported, reason };
}

/**
 * 生成实际要发出的检索词列表（去重、有上限）。
 * 上限与 discoverCommonsFilmStills 的 maxSearches 保持一致，避免一次查询打爆。
 */
export function searchTermsFromIntent(intent, { max = 2 } = {}) {
  const { concepts, unmapped, supported, reason } = conceptsFromIntent(intent);
  const terms = [];
  const seen = new Set();
  for (const c of concepts) {
    if (seen.has(c.term)) continue;
    seen.add(c.term);
    terms.push(c.term);
    if (terms.length >= max) break;
  }
  return { terms, concepts, unmapped, supported, reason };
}

export { ALLOWED_TERMS };
