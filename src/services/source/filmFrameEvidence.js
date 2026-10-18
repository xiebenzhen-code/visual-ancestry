// filmFrameEvidence.js — 远程电影画面的「身份 / 图像性质 / 许可」三条核验轴。
//
// 为什么单独成文件：discoverCommonsFilmStills() 原本只有两个布尔判断
//   · judgeCommonsRights()  → 能不能展示（许可）
//   · looksLikeFilmFrame()  → 是不是影片的一帧（只回 true/false + 原因）
// 但产品要回答的是三个不同的问题：
//   1. 这是哪部电影、哪一年？      → 身份轴（identity）
//   2. 这张图**是什么**？          → 图像性质轴（nature）：逐帧截图 / 场景照 /
//                                   宣传照 / 海报 / 明信片 / lobby card / 无法判定
//   3. 能不能用？依据是什么？      → 许可轴（licence，沿用 judgeCommonsRights）
// 三轴的证据强度不同，混成一个 showable 布尔值就会把「不确定」说成「确定」。
//
// 铁律（与既有代码一致，不放宽）：
//   · 拿不到证据就写 unverified + 原文，不猜、不补、不用模型结论填事实字段。
//   · 导演只从 Commons 自己给出的字段取；取不到就是 null（Commons 元数据确实没有导演，
//     不能拿摄影者/上传者冒充）。本模块**不提供任何改写事实字段的接口**。
//   · 图像性质判不出来时是 unknown/unverified，不是「剧照」。上一轮的教训就是
//     Ross Verlag 明星明信片与宣传照被统一当成剧照。

const CATEGORY_DOUBT = /Media needing category review/i;

// 印刷品类目：海报 / 明信片 / lobby card 都不是「影片画面」。
// 依据上一轮审计的实际命中：File:Брунгильда.jpg（Ross Verlag 明信片）分类含
// "Cinema postcards"，File:Siegfrieds death.jpg 同样；Metropolis 的 lobby card
// 属 "Lobby cards"。这三类必须显式拒绝，否则又会以「电影画面」之名上墙。
const PRINT_CATEGORY = [
  { re: /\bcinema postcards?\b/i, why: "分类含 Cinema postcards：明信片，不是影片画面" },
  { re: /\blobby cards?\b/i, why: "分类含 Lobby cards：影院 lobby 卡，不是影片画面" },
  { re: /\bfilm posters?\b|\b(one[- ]sheet|movie poster)s?\b|\bposters? of\b/i, why: "分类含海报类目：海报不是影片画面" },
  { re: /\bbook illustrations?\b/i, why: "分类含书籍插画：插画不是影片画面" },
];

// 图像性质分类。顺序即优先级：先看标题/对象名的自称（强证据），
// 再看描述（次强），最后才看分类（最弱，且必须同时描述里提到影片）。
const NATURE_RULES = [
  {
    kind: "frame",
    label: "影片画面（逐帧截图）",
    strong: /\b(screenshots?|frame from (the )?film|movie frame|film frame)\b/i,
    weak: /\bscreenshot\b/i,
    needsFilmWord: false,
  },
  {
    kind: "scene-still",
    label: "影片剧照（当年发行／档案的场景照）",
    strong: /\b(film still|movie still|stills? from (the )?(film|movie)|scene (from|of) (the )?(film|movie))\b/i,
    weak: /\bstill from\b/i,
    needsFilmWord: true,
  },
  {
    kind: "publicity-photo",
    label: "宣传照（宣传物料，画面取自影片场景）",
    // 实测：类目写的是复数 "Triangle Film Corporation publicity photos"，
    // 原来的 /publicity (photo|photograph|still)/ 在词边界处匹配不到 photos，
    // 于是这批 1916 年 Intolerance 剧照被错标成普通剧照。允许复数。
    strong: /\b(publicity|promotional|promo)\s+(photo|photograph|still|shot|portrait|pose)s?\b/i,
    weak: /\b(publicity|promotional)\b/i,
    needsFilmWord: false,
  },
  {
    kind: "publicity-still",
    label: "宣传剧照（当年为发行而拍摄的剧照）",
    strong: /\b(publicity still|press still|production still)s?\b/i,
    weak: /\bpress still\b/i,
    needsFilmWord: false,
  },
  {
    kind: "poster",
    label: "电影海报",
    strong: /\b(poster|one[- ]sheet|billing)\b/i,
    weak: /\bposter\b/i,
    needsFilmWord: false,
  },
];

const NATURE_UNKNOWN = {
  kind: "unknown",
  label: "图像性质未标注（Commons 元数据未提供独立证据）",
};

function text(value) {
  return String(value || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function fieldsOf(page) {
  const ii = (page && page.imageinfo && page.imageinfo[0]) || {};
  const em = ii.extmetadata || {};
  const v = (k) => text(em[k]?.value);
  // 优先用结构化 categories（prop=categories 时返回，元素是 "Category:X"），
  // 没有才退回 extmetadata.Categories（无前缀、用 | 分隔）。两者内容相同，
  // 形态不同 —— 上一轮实测就是靠结构化类目才发现那张其实是宣传照。
  const structured = Array.isArray(page?.categories)
    ? page.categories.map((c) => (typeof c === "string" ? c : c.title || "")).join(" | ")
    : "";
  return {
    ii,
    title: text(page?.title).replace(/^File:/, ""),
    objectName: v("ObjectName"),
    description: v("ImageDescription"),
    categories: structured || v("Categories"),
    credit: v("Credit"),
  };
}

// 找到命中的那一句原文，作为证据留痕（产品要求「纠正结果要有证据来源」，
// 这里先保证「判定本身也有证据」）。
function evidenceSnippet(haystack, re) {
  const m = String(haystack || "").match(re);
  if (!m) return "";
  const text_ = String(haystack);
  const start = Math.max(0, m.index - 24);
  return text_.slice(start, m.index + m[0].length + 24).trim();
}

// STEP 2 核验轴 2：图像性质。
// 返回 { kind, label, status, evidence }；status 只有 verified / unverified ——
// 没有第三种「看起来还行」。
export function classifyFrameNature(page) {
  const f = fieldsOf(page);
  const selfName = `${f.title} ${f.objectName}`;

  for (const rule of PRINT_CATEGORY) {
    if (rule.re.test(f.categories)) {
      return {
        kind: "print",
        label: rule.why,
        status: "verified",
        reject: true,
        evidence: f.categories.slice(0, 160),
      };
    }
  }

  for (const rule of NATURE_RULES) {
    const strongHit = rule.strong.exec(selfName);
    if (strongHit) {
      return {
        kind: rule.kind,
        label: rule.label,
        status: "verified",
        reject: rule.kind === "poster",
        evidence: evidenceSnippet(selfName, rule.strong),
      };
    }
  }

  // 类目里的证据（与描述同属独立证据，但优先级更高）：
  // 上一轮实测 "Category:Triangle Film Corporation publicity photos" 正是
  // 那批 1916 年 Intolerance 剧照的真实性质——而它们的描述只写了
  // "Still from the 1916 film Intolerance"。策展方归的类目是**分类**，
  // 描述里的 "still from" 更像一句图注；两者冲突时以类目为准。
  //
  // 判定顺序：prints → title/ObjectName 强证据 → 类目强证据 → 描述弱证据
  // → 「只有 Film stills 类目」= 未标注。
  const categoryNature = NATURE_RULES.find((r) => r.strong && r.strong.test(f.categories));
  if (categoryNature) {
    return {
      kind: categoryNature.kind,
      label: categoryNature.label,
      status: "verified",
      reject: categoryNature.kind === "poster",
      evidence: evidenceSnippet(f.categories, categoryNature.strong),
    };
  }

  // 描述里的证据（弱一档）：宣传照常常只写在描述里。
  const weakNature = NATURE_RULES.find((r) => r.weak && r.weak.test(f.description));
  if (weakNature) {
    return {
      kind: weakNature.kind,
      label: weakNature.label,
      status: "verified",
      reject: weakNature.kind === "poster",
      evidence: evidenceSnippet(f.description, weakNature.weak),
    };
  }

  // 只剩分类命中 —— 与 looksLikeFilmFrame() 同一立场：分类不足以断定性质。
  if (/\bstills?\b|\bfilm stills\b/i.test(f.categories)) {
    return {
      ...NATURE_UNKNOWN,
      status: "unverified",
      evidence: `分类命中 Film stills，但标题与描述未给出独立证据：${text(f.description).slice(0, 120) || "（描述为空）"}`,
    };
  }

  return { ...NATURE_UNKNOWN, status: "unverified", evidence: text(f.description).slice(0, 120) || "（无描述）" };
}

// Commons 影片类目的常见形态："Category:Intolerance (1916 film)" /
// "Category:The Kid (1921 film)" / "Category:Die Büchse der Pandora"。
// 用它反查身份，比从文件名猜可靠：类目本身就是「这是一部某年的影片」。
const FILM_CATEGORY = /Category:\s*(.+?)\s*\((\d{4})\s+film\)/i;

// 文件名去噪。只做两件确定无歧义的事：
//   · 去掉年份被抽走后残留的空括号 "( )" / "（ ）"
//   · 去掉「- 2」这种扫描序列号后缀（带连字符才去，"Alien 3" 这种片名里的数字保留）
// 不做的事：拆解其它标点、猜测副标题、纠正大小写——没有依据就不改。
function cleanFileTitle(raw) {
  return String(raw || "")
    .replace(/\(\s*\)|（\s*）|\[\s*\]/g, " ")
    .replace(/\s+-\s*\d+\s*$/, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function filmIdentityFromCommons(page, fallback = {}) {
  const f = fieldsOf(page);
  const categories = String(f.categories || "");
  const hit = categories.match(FILM_CATEGORY);

  if (hit) {
    return {
      title: hit[1].trim(),
      year: hit[2],
      // Commons 的 imageinfo 没有导演字段。除非页面自带 Wikidata/导演串，
      // 否则一律 null —— 不用摄影者、扫描者冒充。
      director: null,
      directorStatus: "unverified",
      status: "verified",
      evidence: `影片类目「${hit[0]}」`,
    };
  }

  // 没有影片类目：只报告文件名里确实有的部分，其余标 unverified。
  const nameYear = f.title.match(/\b(18|19|20)\d{2}\b/)?.[0] || fallback.year || null;
  return {
    title: cleanFileTitle(fallback.title || null),
    year: nameYear,
    director: null,
    directorStatus: "unverified",
    status: nameYear ? "partial" : "unverified",
    evidence: nameYear
      ? `文件名含年份 ${nameYear}，但页面无「(年份 film)」影片类目`
      : "页面既无影片类目也无年份，仅有文件名推断",
  };
}

// STEP 2 汇总：每条候选必须带的三轴状态。
export function verificationFor({ page, rights, nature, identity }) {
  const axes = [
    {
      axis: "identity",
      label: "电影身份",
      status: identity?.status || "unverified",
      value: identity ? [identity.title, identity.year].filter(Boolean).join(" · ") || "未知" : "未知",
      evidence: identity?.evidence || "",
      extra: identity?.director ? `导演 ${identity.director}` : "导演未知（Commons 未提供）",
    },
    {
      axis: "nature",
      label: "图像性质",
      status: nature?.status || "unverified",
      value: nature?.label || NATURE_UNKNOWN.label,
      evidence: nature?.evidence || "",
    },
    {
      axis: "licence",
      label: "版权依据",
      status: rights?.showable ? "verified" : "unverified",
      value: rights?.licenseShortName || rights?.license || "未知",
      evidence: rights?.rightsCategory || rights?.usageTerms || "",
    },
  ];
  return {
    axes,
    // 整体「可展示」需要三件事同时成立：许可明确、图像性质已核验且不是印刷品、
    // 身份至少部分核验。缺任何一项都逐项显示原因，而不是笼统地「不可用」。
    showable: Boolean(rights?.showable) && nature?.status === "verified" && nature?.reject !== true && identity?.status !== "unverified",
    verifiedCount: axes.filter((a) => a.status === "verified").length,
    axisCount: axes.length,
  };
}

export { PRINT_CATEGORY, NATURE_RULES };