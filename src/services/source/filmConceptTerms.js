// filmConceptTerms.js — STEP 2：受控的**多概念**召回词表。
//
// 上一轮的问题（实测）：单个词映射 + 要求全部用户词都出现在文件名里，两个策略互相打架。
//   · 「冷色、孤独、空旷街道」→ 只发出 landscape 一个检索词，随后却要求三个词都命中 → 必然 0 结果。
//   · 「night city street」→ 只发 night 一个检索词，随后要求三个词都命中 → 必然 0 结果。
//   · 中文查询在最终相关性打分时是拿中文去比英文字段 → 恒为 0 → 全被丢掉。
//
// 本模块只解决「用哪些词去检索」，并且严格守住三条线：
//   1. 保留用户原意：每个被采纳的词都记下它的来源（哪条规则/哪种策略）与可信度。
//   2. 不做视觉推断：「孤独」不映射成任何构图，「冷色」不映射成夜景。
//      无法检索的语义原样报告为 unmapped，而不是替换成一个「差不多」的词。
//   3. 检索词只用于**文件名/类目**匹配，不构成任何画面结论。是否命中画面特征，
//      由调用方按「命中位置」另行判定（见 remoteDiscovery 的 visualStatus）。

// 受控词表。键是用户可能写的词（中英），值是 Commons 文件名/类目里真实可能出现的英文词。
// 只收录我确知对应关系的词；没有把握的一律不加，宁可报 unmapped。
const TERM_RULES = [
  { re: /\b(landscape|paysage|scenery)\b|风景|空旷|辽阔|开阔/i, term: "landscape", source: "受控词表·景观" },
  { re: /\b(street|streets)\b|街道|街头/i, term: "street", source: "受控词表·街道" },
  { re: /\b(city|urban)\b|城市|都市/i, term: "city", source: "受控词表·城市" },
  { re: /\b(night|nighttime|nocturne)\b|夜晚|夜色|黑夜|夜/i, term: "night", source: "受控词表·夜晚" },
  { re: /\b(snow|winter|snowy)\b|雪|冬/i, term: "snow", source: "受控词表·冬季" },
  { re: /\b(sea|ocean|seaside|marine)\b|海|海边/i, term: "sea", source: "受控词表·海景" },
  { re: /\b(forest|woods|wooded)\b|森林|树林/i, term: "forest", source: "受控词表·森林" },
  { re: /\b(mountain|hill|mountains)\b|山|山景/i, term: "mountain", source: "受控词表·山景" },
  { re: /\b(interior|room|indoors)\b|室内|房间/i, term: "interior", source: "受控词表·室内" },
  { re: /\b(desert|dunes)\b|沙漠/i, term: "desert", source: "受控词表·沙漠" },
  { re: /\b(rain|rainy)\b|雨/i, term: "rain", source: "受控词表·雨景" },
  { re: /\b(crowd|crowds)\b|人群| crowd/i, term: "crowd", source: "受控词表·人群" },
  { re: /\b(water|rainwater|river)\b|水|河/i, term: "water", source: "受控词表·水面" },
];

// 英文专名（片名）透传的判定：整句看起来是一个专名而不是视觉描述。
const PROPER_NOUN = /^[A-Za-z][A-Za-z\s'.\-]+$/;

const MAX_TERMS = 3; // 单次查询最多发出 3 个检索词（配合 maxSearches 上限）
const MIN_TERM_LEN = 3;

/**
 * @returns {{terms: Array<{term:string, source:string, confidence:string, matchedToken:string}>,
 *            unmapped: Array<string>, strategy: string, properNoun: boolean}}
 */
export function conceptTerms(query) {
  const raw = String(query || "").trim();
  if (!raw) return { terms: [], unmapped: [], strategy: "empty", properNoun: false };

  const tokens = raw.split(/[、,，\s]+/).map((t) => t.trim()).filter(Boolean);

  // 策略 1：整句像英文专名 → 原样透传（片名查询，不参与多概念拆分）。
  if (PROPER_NOUN.test(raw) && !tokens.some((t) => TERM_RULES.some((r) => r.re.test(t)))) {
    return {
      terms: [{ term: raw, source: "英文片名透传", confidence: "direct", matchedToken: raw }],
      unmapped: [],
      strategy: "proper-noun",
      properNoun: true,
    };
  }

  // 策略 2：逐词找受控映射。一个词可以命中多条规则（「空旷街道」同时命中
  // landscape 与 street），多条都采纳——这正是「多概念」而非「单概念」。
  // 同一个检索词只保留一次，最多 MAX_TERMS 个。
  const seen = new Set();
  const terms = [];
  const unmapped = [];
  for (const token of tokens) {
    const rules = TERM_RULES.filter((r) => r.re.test(token));
    if (!rules.length) {
      // 不做「差不多」的替换：语义无法检索就如实记为未映射。
      unmapped.push(token);
      continue;
    }
    for (const rule of rules) {
      if (seen.has(rule.term)) continue;
      seen.add(rule.term);
      terms.push({
        term: rule.term,
        source: rule.source,
        // 可信度只描述「这个词与渠道检索词的关系有多确定」，不描述画面相似度。
        confidence: "bounded",
        matchedToken: token,
      });
      if (terms.length >= MAX_TERMS) break;
    }
    if (terms.length >= MAX_TERMS) break;
  }

  // 被 MAX_TERMS 截断的词也要如实报告，不能让人以为全部用上了。
  for (const token of tokens) {
    const rule = TERM_RULES.find((r) => r.re.test(token));
    if (rule && !seen.has(rule.term)) unmapped.push(token);
  }

  return { terms, unmapped, strategy: "multi-concept", properNoun: false };
}

/**
 * 把概念拆分结果写成人能读的一句话（渠道摘要与卡片都用它）。
 *
 * MEASURED 教训：电影渠道原来复用绘画渠道那个「单词解释器」，于是摘要里写着
 * 「city、street 未参与本次渠道检索」，而同一屏的统计却显示 city 召回了 3 件。
 * 两句话互相打架，用户无法判断哪句是真的 —— 单词解释器在多概念策略下已经不成立，
 * 必须由多概念结果自己生成说明。
 */
export function describeConcepts(concepts) {
  if (!concepts || !concepts.terms || !concepts.terms.length) {
    return concepts?.strategy === "empty" ? "空查询" : "无有界映射，未发出任何渠道检索";
  }
  if (concepts.properNoun) {
    return `英文片名原样透传：「${concepts.terms[0].term}」`;
  }
  const used = concepts.terms.map((t) => `「${t.term}」`).join("、");
  const unmapped = (concepts.unmapped || []).length
    ? `未参与检索的词：${concepts.unmapped.join("、")}（渠道无法按此语义检索，未做任何替换）`
    : "所有词都按受控词参与了检索";
  return `多概念召回：${used} 均按受控词分别检索；${unmapped}`;
}

/**
 * 判断某个检索词在候选的哪个位置命中。
 * 关键区分（任务书明令）：片名里含 night/street **不能**解释为画面具有夜景/街道。
 *   · description / categories 命中 → metadata-backed（描述或类目声称与该概念有关）
 *   · 仅 title 命中 → title-only（很可能只是片名撞词，画面未被验证）
 */
export function locateTerm(page, meta, term) {
  const t = String(term || "").toLowerCase();
  if (!t) return { location: "none", matched: false };
  const title = `${page.title || ""} ${meta?.title || ""}`.toLowerCase();
  const ii = (page.imageinfo || [])[0] || {};
  const em = ii.extmetadata || {};
  const strip = (v) => String(v || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").toLowerCase();

  // MEASURED 陷阱：不少文件的描述就是「Still from the film <片名>」——把片名
  // 原样抄了一遍。若直接拿描述判断命中位置，《Saturday Night》会拿到
  // 「描述命中」，看起来像夜晚画面召回，其实只是片名在描述里重复了一次。
  // 所以先把这件作品自己的片名从句子里抹掉，剩下的才算渠道对画面的描述。
  const filmTitle = String(meta?.title || "").toLowerCase().trim();
  const scrub = (s) => {
    let out = strip(s);
    if (filmTitle.length >= 3) out = out.split(filmTitle).join(" ");
    // 片名在描述里可能被拆成词（如 "Saturday Night" → 词序相同但大小写/标点不同），
    // 再按词序做一次宽松抹除。
    const words = filmTitle.split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
    if (words.length >= 2) {
      const joined = words.join("[^a-z0-9]+");
      out = out.replace(new RegExp(joined, "g"), " ");
    }
    return out;
  };

  const description = scrub(em.ImageDescription?.value);
  const categories = scrub(em.Categories?.value);
  const inTitle = title.includes(t);
  const inDescription = description.includes(t);
  const inCategories = categories.includes(t);
  if (inDescription || inCategories) {
    return {
      location: inDescription && inCategories ? "description+category" : inDescription ? "description" : "category",
      matched: true,
      inTitle,
      inDescription,
      inCategories,
    };
  }
  if (inTitle) return { location: "title-only", matched: true, inTitle, inDescription: false, inCategories: false };
  return { location: "none", matched: false, inTitle: false, inDescription: false, inCategories: false };
}

export { TERM_RULES, MAX_TERMS };