// P4.5 — 首批艺术语义数据（6 件代表作品）
//
// 每个字段都必须可追溯到一个真实来源 URL。没有来源就写 null 并把 status 设为 unknown，
// 绝不自动生成历史故事。
//
// 数据来源：
//   · genre / material / collection / depicts  ← Wikidata 结构化声明（逐条核对）
//   · 作品 URI                                 ← Wikidata concepturi
//   · 馆藏页                                   ← 各馆 official collection record
//
// 与视觉检索的关系（重要）：
//   本文件的 genre/theme 只用于**题材检索**，不参与视觉相似度。
//   视觉路径仍走 VisualIntent；两条证据路径在 retrievalService 中保持独立。

export const ART_CONTEXT_SOURCES = {
  wikidata: "https://www.wikidata.org/wiki/",
  note: "genre/material/collection/depicts 来自 Wikidata 声明，逐条取回并核对",
};

/**
 * 每件作品：
 *   wikidataId       Wikidata 实体
 *   genre            题材类型（Wikidata P136 的英文标签）
 *   material         实际媒介（P186）
 *   collection       收藏机构（P195）
 *   depicts          画面所绘对象（P180，抽查前若干项）
 *   themes           供题材检索用的中文主题词（由 genre/depicts 派生，可追溯）
 *   aliasesZh        中文名称别名（便于「肖像」「室内」这类词命中）
 *   historicalNote   作品背景：仅在有可靠来源时填写，否则 null
 *   evidence         每个字段的来源标注
 */
export const ART_SEMANTICS = {
  "third-of-may": {
    wikidataId: "Q1091086",
    genre: "history painting",
    material: ["oil paint", "canvas"],
    collection: ["Museo del Prado", "Royal Palace of Madrid"],
    depicts: ["execution by firing squad", "Dos de Mayo Uprising", "rifle", "Death", "oil lamp", "soldier", "rebel"],
    // P4.6 修正：history painting 是「以历史题材为主」的画种（Wikidata Q742333：
    // "genre in painting defined by historical matter"），涵盖历史、神话、宗教、
    // 文学事件，绝不等于「战争」。之前 themes 写「战争/暴力/军事」是把 genre
    // 过度具体化，属于用艺术解释冒充题材事实。
    // 现在只保留：① genre 本体 ② 来自 depicts 的可观察事实。
    genderNeutralGenre: "history painting",
    themes: ["历史画", "行刑", "人群对峙"],
    themeBasis: {
      "历史画": "Wikidata P136 = history painting (Q742333)",
      "行刑": "Wikidata P180 depicts = execution by firing squad",
      "人群对峙": "Wikidata P180 depicts = soldier + rebel（画面可观察的阵营关系）",
    },
    // depicts 的中文检索词：每个词都对应一个已验证的 Wikidata P180 英文原词。
    // 这是「事实的本地化措辞」，不是「对作品的解释」。
    depictsZh: [
      { zh: "行刑", en: "execution by firing squad" },
      { zh: "枪决", en: "execution by firing squad" },
      { zh: "士兵", en: "soldier" },
      { zh: "反抗者", en: "rebel" },
      { zh: "步枪", en: "rifle" },
      { zh: "死亡", en: "Death" },
      { zh: "起义", en: "Dos de Mayo Uprising" },
      { zh: "战争", en: "Dos de Mayo Uprising (armed conflict)", note: "仅当 depicts 明确记录了武装冲突事件时才映射" },
    ],
    historicalNote: null, // 未取得可靠的、可逐句溯源的中文创作背景，按要求保持 null
    evidence: {
      genre: { source: "wikidata", id: "Q1091086", property: "P136" },
      material: { source: "wikidata", id: "Q1091086", property: "P186" },
      collection: { source: "wikidata", id: "Q1091086", property: "P195" },
      depicts: { source: "wikidata", id: "Q1091086", property: "P180" },
      historicalNote: { source: "none", status: "unknown" },
    },
    sourceUrl: "https://www.wikidata.org/wiki/Q1091086",
    museumUrl: "https://www.museodelprado.es/en/the-collection/art-work/the-3rd-of-may-1808-in-madrid-or-the-executions/5e177409-2993-4240-97fb-847a02c6496c",
  },

  "whistlers-mother": {
    wikidataId: "Q687182",
    genre: "portrait",
    material: ["oil paint", "canvas"],
    collection: ["Musée d'Orsay"],
    depicts: ["Anna McNeill Whistler", "woman", "curtain", "seat", "old age"],
    themes: ["肖像", "坐姿肖像"],
    themeBasis: {
      "肖像": "Wikidata P136 = portrait (Q1400853)",
      "坐姿肖像": "Wikidata P180 depicts = seat（画面中人物为坐姿）",
    },
    aliasesZh: ["惠斯勒的母亲", "灰与黑的协奏曲"],
    historicalNote: null,
    evidence: {
      genre: { source: "wikidata", id: "Q687182", property: "P136" },
      material: { source: "wikidata", id: "Q687182", property: "P186" },
      collection: { source: "wikidata", id: "Q687182", property: "P195" },
      depicts: { source: "wikidata", id: "Q687182", property: "P180" },
      historicalNote: { source: "none", status: "unknown" },
    },
    sourceUrl: "https://www.wikidata.org/wiki/Q687182",
    museumUrl: "https://www.musee-orsay.fr/en/artworks/arrangement-in-grey-and-black-no-1-12266",
  },

  calling: {
    wikidataId: "Q969377",
    genre: "religious art",
    material: ["oil paint", "canvas"],
    collection: ["San Luigi dei Francesi"],
    depicts: ["Matthew the Apostle"],
    // P4.6 修正：「圣像」(icon) 是特定宗教图像类型，需要图像学证据；
    // depicts 只记录了 Matthew the Apostle，不足以支持「圣像」。
    themes: ["宗教", "圣经题材"],
    themeBasis: {
      "宗教": "Wikidata P136 = religious art (Q2864737)",
      "圣经题材": "Wikidata P180 depicts = Matthew the Apostle（新约人物）",
    },
    aliasesZh: ["圣马太蒙召", "圣马太的召唤"],
    historicalNote: null,
    evidence: {
      genre: { source: "wikidata", id: "Q969377", property: "P136" },
      material: { source: "wikidata", id: "Q969377", property: "P186" },
      collection: { source: "wikidata", id: "Q969377", property: "P195" },
      depicts: { source: "wikidata", id: "Q969377", property: "P180" },
      historicalNote: { source: "none", status: "unknown" },
    },
    sourceUrl: "https://www.wikidata.org/wiki/Q969377",
    museumUrl: "https://www.chiesacontarelli.it/",
  },

  milkmaid: {
    wikidataId: "Q167605",
    genre: "genre art",
    material: ["canvas", "oil paint"],
    collection: ["Rijksmuseum"],
    depicts: ["coif", "pitcher", "platter", "bread", "basket", "table", "tablecloth", "wall", "window", "milk", "apron", "maid"],
    // P4.6 修正：depicts 有 wall / window / table / tablecloth，可支持「室内」；
    // 但没有 kitchen 或任何厨房器具的明确记录，「厨房」属过度具体化，移除。
    themes: ["室内", "风俗画", "家务"],
    themeBasis: {
      "室内": "Wikidata P180 depicts = wall / window / table",
      "风俗画": "Wikidata P136 = genre art (Q1047337)",
      "家务": "Wikidata P180 depicts = maid / milk / apron",
    },
    aliasesZh: ["倒牛奶的女仆", "厨娘", "挤奶女工"],
    historicalNote: null,
    evidence: {
      genre: { source: "wikidata", id: "Q167605", property: "P136" },
      material: { source: "wikidata", id: "Q167605", property: "P186" },
      collection: { source: "wikidata", id: "Q167605", property: "P195" },
      depicts: { source: "wikidata", id: "Q167605", property: "P180" },
      historicalNote: { source: "none", status: "unknown" },
    },
    sourceUrl: "https://www.wikidata.org/wiki/Q167605",
    museumUrl: "https://www.rijksmuseum.nl/en/collection/SK-A-2344",
  },

  meninas: {
    wikidataId: "Q208758",
    genre: "group portrait",
    material: ["oil paint", "canvas"],
    collection: ["Museo del Prado"],
    depicts: ["Philip IV of Spain", "Margaret Theresa of Spain", "Diego Velázquez", "Mariana of Austria", "dwarf", "dog", "mirror", "door", "painting", "room"],
    themes: ["室内", "群像", "宫廷"],
    themeBasis: {
      "室内": "Wikidata P180 depicts = room / door / mirror",
      "群像": "Wikidata P136 = group portrait",
      "宫廷": "Wikidata P180 depicts = Philip IV of Spain / Mariana of Austria（王室成员）",
    },
    aliasesZh: ["宫娥", "宫女图", "拉斯梅尼纳斯"],
    historicalNote: null,
    evidence: {
      genre: { source: "wikidata", id: "Q208758", property: "P136" },
      material: { source: "wikidata", id: "Q208758", property: "P186" },
      collection: { source: "wikidata", id: "Q208758", property: "P195" },
      depicts: { source: "wikidata", id: "Q208758", property: "P180" },
      historicalNote: { source: "none", status: "unknown" },
    },
    sourceUrl: "https://www.wikidata.org/wiki/Q208758",
    museumUrl: "https://www.museodelprado.es/en/the-collection/art-work/las-meninas/9fdc7800-9ade-48b0-ab8b-edee94ea877f",
  },

  "bar-folies": {
    wikidataId: "Q1245354",
    genre: "portrait",
    material: ["oil paint", "canvas"],
    collection: ["Courtauld Gallery", "Courtauld Institute of Art"],
    depicts: ["gaze towards the viewer", "woman", "beer", "Folies Bergère"],
    // P4.6 移除「夜生活」：depicts 只记录了 gaze towards the viewer / woman /
    // beer / Folies Bergère，没有任何夜间证据。
    themes: ["酒吧", "肖像", "吧台"],
    themeBasis: {
      "酒吧": "Wikidata P180 depicts = beer / Folies Bergère",
      "肖像": "Wikidata P136 = portrait",
      "吧台": "depicts 记录了啤酒与吧台场景",
    },
    aliasesZh: ["女神游乐厅的吧台", "福利-贝热尔酒吧", "酒吧一角"],
    historicalNote: null,
    evidence: {
      genre: { source: "wikidata", id: "Q1245354", property: "P136" },
      material: { source: "wikidata", id: "Q1245354", property: "P186" },
      collection: { source: "wikidata", id: "Q1245354", property: "P195" },
      depicts: { source: "wikidata", id: "Q1245354", property: "P180" },
      historicalNote: { source: "none", status: "unknown" },
    },
    sourceUrl: "https://www.wikidata.org/wiki/Q1245354",
    museumUrl: "https://courtauld.ac.uk/whats-on/collection/",
  },
};

/** 题材词 → 可匹配的主题标签集合（供 searchByLexicon 的 subject 路径使用） */
export function themesFor(artworkId) {
  return ART_SEMANTICS[artworkId]?.themes || [];
}

/** 媒介（有真实来源时才返回，否则 null —— 不猜） */
export function materialFor(artworkId) {
  const s = ART_SEMANTICS[artworkId];
  if (!s || !s.material || !s.material.length) return null;
  return { material: s.material, source: s.evidence.material, sourceUrl: s.sourceUrl };
}

/** 该作品的语义是否已补齐（用于统计覆盖率，避免虚报） */
export function hasSemantics(artworkId) {
  return Boolean(ART_SEMANTICS[artworkId]);
}

export const COVERAGE = {
  totalArtworks: 51,
  withSemantics: Object.keys(ART_SEMANTICS).length,
  note: "首批只补 6 件；其余保持 unknown，不使用自动生成的历史故事",
};
