// relationTier.js — 视觉关联档位（生产实现，单一来源）
// 逻辑见实验模块同名文件的注释；此处为仓库内正式路径，供 server/vision 与实验脚本共用。// relation-audit.mjs — P4.15.4 视觉关联档位的证据约束
//
// 背景（P4.15.3 真实数据暴露的问题）：
//   · 模型的 compositionEvidence / subjectRelationEvidence / colorLightEvidence 三个字段
//     有时描述查询图、有时描述候选图，**不是「两张图共享什么」的断言**；
//     similarPoints 同样经常只是在描述其中一张画。
//   · 唯一稳定指向候选一方的字段是 majorDifferences（句式「候选N为…」）。
//   · 旧映射把这些字段当作相似证据 → 每个候选都有三段描述 → 永远“有证据” → partial 泛滥
//     （《美国哥特式》6/6 partial，0 unrelated）。
//
// 本模块只做一件事：用**可证伪的冲突**去检验模型声称的相似点，
// 把站得住的维度留下，把被差异直接推翻的维度划掉，再按剩余维度定档。
//
// 四档（rank 越大越弱）：
//   high      主要视觉组织（构图 + 主体或空间）有较强关联
//   partial   有具体可核实的组织关联，但重要差异明显
//   specific  只剩色彩/光线/局部形式/单项技法，不构成整体画面关联
//   unrelated 没有足够具体的可迁移证据
//
// 纪律：任何情况下不得把模型给的档位**往上调**（min 语义）；模型说 unrelated 就是 unrelated。

export const TIERS = Object.freeze({
  HIGH: "high",
  PARTIAL: "partial",
  SPECIFIC: "specific",
  UNRELATED: "unrelated",
});

const RANK = { high: 3, partial: 2, specific: 1, unrelated: 0 };

/** 取更弱的一档（不升级）。 */
export function minTier(a, b) {
  return RANK[a] <= RANK[b] ? a : b;
}

const DIM_WORDS = {
  composition: ["构图", "骨架", "布局", "位置", "排列", "居中", "中轴", "对称", "三角", "对角", "斜线", "透视", "重心", "竖幅", "横幅", "立轴", "层叠", "留白"],
  subject: ["人物", "主体", "单人", "双人", "两人", "三人", "群像", "多人", "视线", "姿态", "站姿", "坐姿", "并排", "并立", "对视", "朝向", "面部"],
  space: ["空间", "纵深", "透视", "前景", "中景", "背景", "远景", "远近", "层次", "前中后", "室内", "室外", "街道", "水面", "天空", "场景", "户外"],
  colorLight: ["色", "色调", "明度", "光线", "光", "光影", "冷暖", "饱和", "对比", "阴影", "亮部", "暗部", "留白"],
};

/** 一句话落在哪些维度（可多选）。 */
export function dimsOf(text) {
  const t = String(text || "");
  if (!t.trim()) return [];
  return Object.keys(DIM_WORDS).filter((d) => DIM_WORDS[d].some((w) => t.includes(w)));
}

/* ---------- 可证伪的冲突信号 ---------- */

const COUNT_PATTERNS = [
  ["zero", /无人物|没有人|未见.{0,4}人物|不含人物/],
  ["one", /单人|一名|一个(人|女性|男性)|独自/],
  ["two", /两人|双人|二人|一男一女|一对/],
  ["many", /三人|多人|群像|数人|几名|众人|人群|分散.{0,6}(人|舞者|行人)/],
];

function countsIn(text) {
  const t = String(text || "");
  const out = new Set();
  for (const [k, re] of COUNT_PATTERNS) if (re.test(t)) out.add(k);
  return out;
}

/** 人数/主体数量冲突：一侧必然被另一侧推翻。 */
function countConflict(sideA, sideB) {
  const a = countsIn(sideA);
  const b = countsIn(sideB);
  if (!a.size || !b.size) return null;
  const los = (x, ys) => ys.some((y) => b.has(y)) || ys.some((y) => a.has(y));
  if (a.has("zero") && ["one", "two", "many"].some((y) => b.has(y))) return "主体数量：一侧无人、另一侧有人";
  if (b.has("zero") && ["one", "two", "many"].some((y) => a.has(y))) return "主体数量：一侧无人、另一侧有人";
  if (a.has("one") && (b.has("two") || b.has("many"))) return "主体数量：单人 vs 多人";
  if (b.has("one") && (a.has("two") || a.has("many"))) return "主体数量：单人 vs 多人";
  if (a.has("two") && b.has("many")) return "主体数量：两人 vs 三人以上";
  if (b.has("two") && a.has("many")) return "主体数量：两人 vs 三人以上";
  return null;
}

const OPPOSITES = [
  [["室内", "房间内", "屋内"], ["室外", "户外", "街道", "天空", "野外"], "场景：室内 vs 室外/街景"],
  [["竖幅", "立轴", "纵向"], ["横幅", "横卷", "横向"], "画幅：竖幅 vs 横幅"],
  [["拥抱", "交叠", "相拥"], ["并排站立", "并立", "并排", "站立"], "人物关系：交叠 vs 并立"],
  [["分散", "各异", "不同朝向"], ["直视", "正面朝向", "统一朝向"], "人物朝向：分散 vs 统一"],
];


/** 一句差异里同时出现对立的两种情况，说明这一句在对照查询与候选。 */
const LINE_PAIRS = [
  [["室内", "屋内", "房间"], ["室外", "户外", "街道", "天空"], "space", "场景：室内 vs 室外"],
  [["竖幅", "立轴", "纵向"], ["横幅", "横卷", "横向"], "composition", "画幅：竖幅 vs 横幅"],
  [["拥抱", "相拥", "交叠"], ["并排站立", "并立", "并排"], "subject", "人物关系：交叠 vs 并立"],
  [["分散", "各异", "不同朝向"], ["直视", "正面朝向", "统一朝向"], "subject", "人物朝向：分散 vs 统一"],
  [["纵深", "透视", "街道"], ["平面化", "建筑立面", "墙面"], "space", "空间：纵深街景 vs 立面/平面"],
  [["平面", "无纵深", "平面化"], ["写实", "建筑", "透视"], "space", "空间：平面化 vs 写实空间"],
];

function lineContradictions(similarText, differences) {
  const out = {};
  for (const line of differences || []) {
    const c = countConflict(similarText, line);
    if (c) {
      out.subject = out.subject || c;
      out.composition = out.composition || "主体数量不符，构图对照失去依据";
    }
    for (const [xs, ys, dim, label] of LINE_PAIRS) {
      const hitX = xs.some((x) => line.includes(x));
      const hitY = ys.some((y) => line.includes(y));
      if (hitX && hitY) out[dim] = out[dim] || label;
    }
    // 同一句里直接写「与查询…不同 / 结构不同 / 空间逻辑相反」的维度
    // 只有「整类否定」才算证伪；「不似/更对称」这类细部差别不动整维
    if (/完全不同|性质完全不同|空间逻辑相反|骨架.{0,4}(不同|不符)|与查询.{0,8}不同/.test(line)) {
      const dims = dimsOf(line);
      if (dims.length === 1) out[dims[0]] = out[dims[0]] || `差异直接否定：${line.slice(0, 24)}`;
    }
  }
  return out;
}

/**
 * 用差异检验相似点：某维度若被具体差异直接推翻，该维度不算正面证据。
 * 这是**证伪**，不是打分：一句话里同时出现对立两侧，就说明它在对照两张图。
 */
export function falsify(similarPoints, differences) {
  const similarText = (similarPoints || []).join("；");
  const contradicted = lineContradictions(similarText, differences);
  return contradicted;
}

/**
 * 由证据推导档位。
 * @returns {{relation:string, positiveDims:string[], contradicted:object, notes:string[]}}
 */
export function deriveRelation(j) {
  const similar = j?.similarPoints || [];
  const diffs = j?.majorDifferences || [];
  const notes = [];

  const positive = new Set();
  for (const p of similar) for (const d of dimsOf(p)) positive.add(d);

  const contradicted = falsify(similar, diffs);
  for (const d of Object.keys(contradicted)) {
    if (positive.delete(d)) notes.push(`${d} 被差异推翻：${contradicted[d]}`);
  }

  const substantive = ["composition", "subject", "space"].filter((d) => positive.has(d));
  const hasColor = positive.has("colorLight");

  let relation;
  if (substantive.length === 0) {
    relation = hasColor || positive.size > 0 ? TIERS.SPECIFIC : TIERS.UNRELATED;
    if (relation === TIERS.SPECIFIC) notes.push("只剩色彩/光线/局部形式可借鉴");
    else notes.push("没有可核对的可迁移证据");
  } else if (substantive.includes("composition") && (substantive.includes("subject") || substantive.includes("space"))) {
    relation = TIERS.HIGH;
    notes.push("构图与主体/空间同时成立");
  } else {
    relation = TIERS.PARTIAL;
    notes.push(`只有部分组织维度成立：${substantive.join("/")}`);
  }


  return { relation, positiveDims: [...positive], contradicted, notes };
}

/** 综合模型档位与证据档位：只降不升。 */
export function adjudicate(modelVerdict, j) {
  const derived = deriveRelation(j);
  const relation = minTier(modelVerdict || TIERS.UNRELATED, derived.relation);
  return { relation, modelVerdict, derived: derived.relation, positiveDims: derived.positiveDims, contradicted: derived.contradicted, notes: derived.notes };
}
