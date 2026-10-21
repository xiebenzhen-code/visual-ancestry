// styleBranches.js — 「同风格，换 X」四条探索分支。
//
// 每条分支只做一件事：**保留风格，改变一个明确维度**，并说清楚
//   保留了什么 / 改变了什么 / 证据从哪来 / 有没有经过 Vision 验证。
//
// 纪律（与 P4.15 的档位体系刻意解耦）：
//   · 这里不读、也不用 P4.15.4 的四档判定。四档是"某查询下证据够不够"的结论，
//     不是"这件作品属于什么风格"的标签，拿它做门禁会把 40 件没判过的作品全挡掉。
//   · 没有独立画像（A 级）的作品，一律标「未分析」，绝不把档案描述说成模型结论。
//   · 结果可以是空的。空就是空，不靠重复已经出现过的作品凑满四栏。

import { artworks } from "../../data/artworks.js";
import { VISION_PROFILES } from "../../data/vision-profiles.js";
import { filmStills, filterByMedia, metricsOf, kindOf } from "./media.js";

/* ---------------- 文本特征 ---------------- */

const TXT = (w) => [
  w.titleZh || "", w.title || "", w.composition || "", w.lighting || "",
  w.color || "", w.spatialStructure || "", (w.visualDNA || []).join(" "),
].join(" ");

const PEOPLE_WORDS = /人物|肖像|双人|两人|三人|单人|群像|舞者|母亲|少女|妇人|男子|女子|人像|自画像|孩童|孩子|农夫|市民|拥抱|坐姿|站立|行人|人群|portrait|self-portrait|madonna|woman|man\b|girl|boy|family|couple|dancers|figure/gi;
const CITY_WORDS = /街道|建筑|房屋|屋|窗|桥|城|广场|墙|街区|码头|港口|street|city|town|bridge|square|harbou?r|building|cathedral|station|avenue/gi;
const LAND_WORDS = /山|水面|海|雪|林|树|云|瀑|田野|河谷|原野|江|湖|舟|钓|港|mountain|landscape|river|lake|sea|ocean|forest|snow|valley|field|garden|cliff|coast/gi;

const hits = (text, re) => (text.match(re) || []).length;

/**
 * 主体分类：计分制。至少要 2 个证据词才算一类，否则归 other。
 * 「其他」不参与换主体/换场景——认不出来就不要硬分，宁可空一栏。
 * 山水里的点景人物（人物极小/缩为微点）不改变主体性质。
 */
export function subjectClass(work) {
  const t = TXT(work);
  if (/人物极小|人物很小|缩为微点|微点|极小的人物|点景人物/.test(t)) return "landscape";
  const score = { people: hits(t, PEOPLE_WORDS), city: hits(t, CITY_WORDS), landscape: hits(t, LAND_WORDS) };
  const best = Object.entries(score).sort((a, b) => b[1] - a[1])[0];
  if (!best || best[1] < 2) return "other";
  return best[0];
}

const INDOOR_WORDS = /室内|房间|屋内|桌面|教堂内|室内空间|闺房|interior|room|indoors|parlour|parlor/gi;
const NIGHT_WORDS = /夜|灯火|月光|暮色|night|moonlight|evening|dusk/gi;

export function sceneClass(work) {
  const t = TXT(work);
  const score = {
    indoor: hits(t, INDOOR_WORDS),
    night: hits(t, NIGHT_WORDS),
    urban: hits(t, CITY_WORDS),
    nature: hits(t, LAND_WORDS),
  };
  const best = Object.entries(score).sort((a, b) => b[1] - a[1])[0];
  if (!best || best[1] < 2) return "other";
  return best[0];
}

const bucketOf = (aspect) => (aspect > 1.15 ? "tall" : aspect < 0.85 ? "wide" : "square");

export function compositionProfile(work) {
  const m = work.metrics || metricsOf(work.id);
  if (!m) return null;
  const vertical = m.lumTop - m.lumBottom > 0.06 ? "top-heavy" : m.lumTop - m.lumBottom < -0.06 ? "bottom-heavy" : "even";
  return {
    bucket: bucketOf(m.aspect),
    vertical,
    symmetry: m.asymmetry < 0.12 ? "symmetric" : "asymmetric",
    asymmetry: m.asymmetry,
    aspect: m.aspect,
  };
}

export function colorProfile(work) {
  const m = work.metrics || metricsOf(work.id);
  if (!m) return null;
  return {
    warmth: m.warmth,
    warmthValue: m.warmthValue,
    sat: m.meanSat,
    contrast: m.contrast,
    lum: m.meanLum,
  };
}

const overlap = (a = [], b = []) => a.filter((x) => b.includes(x));

function localPool() {
  return artworks
    .filter((a) => a.image && !a.imageUnavailable)
    .map((a) => ({
      id: a.id,
      kind: "artwork",
      key: a.key,
      title: a.title,
      titleZh: a.titleZh,
      year: a.year,
      artist: a.artist,
      artistZh: a.artistZh,
      image: a.image,
      metrics: metricsOf(a.id),
      traditions: a.traditions || [],
      emotion: a.emotion || [],
      atmosphere: a.atmosphere || [],
      visualDNA: a.visualDNA || [],
      composition: a.composition || "",
      lighting: a.lighting || "",
      color: a.color || "",
      spatialStructure: a.spatialStructure || "",
      href: `#artwork/${a.key}`,
    }));
}

/** 全部候选：本地 51 件 + 15 张电影剧照（含黑白，交给 filterByMedia 剔除）。 */
export function explorePool() {
  return [...localPool(), ...filmStills()];
}

/* ---------------- 分支定义 ---------------- */

const SUBJECT_LABEL = { people: "人物", city: "城市/建筑", landscape: "自然山水", other: "其他" };
const SCENE_LABEL = { indoor: "室内", night: "夜景", urban: "城市外部", nature: "自然环境", other: "其他" };
const BUCKET_LABEL = { tall: "竖幅", wide: "横幅", square: "近方形" };

export const BRANCHES = [
  {
    id: "subject",
    label: "同风格，换主体",
    changeDim: "主体",
    preserves: "画派/传统、整体气质",
  },
  {
    id: "scene",
    label: "同风格，换场景",
    changeDim: "场景",
    preserves: "画派/传统、用色与光感",
  },
  {
    id: "composition",
    label: "同风格，换构图",
    changeDim: "构图骨架",
    preserves: "画派/传统",
  },
  {
    id: "local",
    label: "探索局部视觉语言",
    changeDim: "只借色彩与光线，其余都换",
    preserves: "色彩关系、明暗组织",
  },
];

const MAX_PER_BRANCH = 4;

function visionNote(queryId, results) {
  const queryVerified = Boolean(VISION_PROFILES.profiles[queryId]);
  if (!results.length) {
    return { queryVerified, verifiedCount: 0, note: "这一栏没有候选，谈不到验证。", tone: "none" };
  }
  const verified = results.filter((r) => Boolean(VISION_PROFILES.profiles[(r.work && r.work.id) || r.id]));
  if (!queryVerified && !verified.length) {
    return {
      queryVerified,
      verifiedCount: 0,
      note: "未验证：结论来自档案描述与像素实测，不是模型看图得出的。",
      tone: "none",
    };
  }
  if (queryVerified && verified.length) {
    return {
      queryVerified,
      verifiedCount: verified.length,
      note: `查询与 ${verified.length} 件候选都有独立单图画像（A 级）。`,
      tone: "full",
    };
  }
  return {
    queryVerified,
    verifiedCount: verified.length,
    note: queryVerified
      ? "查询有独立画像；候选没有，候选一侧仍是档案+像素推导。"
      : "候选有独立画像；查询本身没有，方向判断仍靠档案。",
    tone: "partial",
  };
}

/**
 * 生成四条分支。
 * @param {object} query 本地作品（artworks 里的条目）
 * @param {{media?:string}} opts
 */
export function buildBranches(query, { media = "all" } = {}) {
  const queryId = query.id;
  const base = {
    id: queryId,
    kind: "artwork",
    metrics: metricsOf(queryId),
    traditions: query.traditions || [],
    emotion: query.emotion || [],
    atmosphere: query.atmosphere || [],
    visualDNA: query.visualDNA || [],
    composition: query.composition || "",
    lighting: query.lighting || "",
    color: query.color || "",
    spatialStructure: query.spatialStructure || "",
    titleZh: query.titleZh,
  };
  const qSubject = subjectClass(base);
  const qScene = sceneClass(base);
  const qComp = compositionProfile(base);
  const qColor = colorProfile(base);

  const pool = explorePool().filter((w) => w.id !== queryId);
  const { items, excluded, emptyReason } = filterByMedia(pool, media, "artwork");

  // 一件作品只在一个分支里出现。允许跨分支重复会变成"凑满四栏"，
  // 用户看到的就不是四种变化，而是同一张图换四种说法。
  const usedIn = new Map();
  const take = (scored, branchId) =>
    scored
      .filter(({ work }) => (usedIn.get(work.id) || 0) < 1)
      .slice(0, MAX_PER_BRANCH)
      .map((row) => {
        usedIn.set(row.work.id, (usedIn.get(row.work.id) || 0) + 1);
        return { ...row, branch: branchId };
      });

  const traditionsOf = (w) => overlap(base.traditions, w.traditions);

  // B1 同风格，换主体
  const subjectRows = items
    .map((work) => {
      const trad = traditionsOf(work);
      const subj = subjectClass(work);
      if (!trad.length || subj === qSubject || subj === "other") return null;
      const score = trad.length * 3 + overlap(base.emotion, work.emotion).length * 0.5;
      return {
        work, score,
        preserves: `同属 ${trad.join(" / ")}`,
        changes: `主体从「${SUBJECT_LABEL[qSubject]}」换成「${SUBJECT_LABEL[subj]}」`,
        evidence: [
          { kind: "档案", text: `traditions 交集：${trad.join("、")}` },
          { kind: "档案", text: `主体判断：${SUBJECT_LABEL[qSubject]} → ${SUBJECT_LABEL[subj]}（依据画面描述与视觉 DNA）` },
        ],
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  // B2 同风格，换场景
  const sceneRows = items
    .map((work) => {
      const trad = traditionsOf(work);
      const sc = sceneClass(work);
      if (!trad.length || sc === qScene || sc === "other") return null;
      return {
        work, score: trad.length * 3,
        preserves: `同属 ${trad.join(" / ")}`,
        changes: `场景从「${SCENE_LABEL[qScene]}」换成「${SCENE_LABEL[sc]}」`,
        evidence: [
          { kind: "档案", text: `traditions 交集：${trad.join("、")}` },
          { kind: "档案", text: `场景判断：${SCENE_LABEL[qScene]} → ${SCENE_LABEL[sc]}` },
        ],
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  // B3 同风格，换构图（像素实测支持）
  const compRows = items
    .map((work) => {
      const trad = traditionsOf(work);
      const comp = compositionProfile(work);
      if (!trad.length || !comp || !qComp) return null;
      const diffs = [];
      if (comp.bucket !== qComp.bucket) diffs.push(`画幅 ${BUCKET_LABEL[qComp.bucket]} → ${BUCKET_LABEL[comp.bucket]}`);
      if (comp.vertical !== qComp.vertical) diffs.push(`明度重心 ${qComp.vertical} → ${comp.vertical}`);
      if (comp.symmetry !== qComp.symmetry) diffs.push(`对称性 ${qComp.symmetry} → ${comp.symmetry}`);
      if (diffs.length < 2) return null;
      return {
        work, score: trad.length * 3 + diffs.length,
        preserves: `同属 ${trad.join(" / ")}`,
        changes: `构图骨架换了两处以上：${diffs.join("；")}`,
        evidence: [
          { kind: "档案", text: `traditions 交集：${trad.join("、")}` },
          { kind: "像素实测", text: `长宽比 ${qComp.aspect.toFixed(2)} → ${comp.aspect.toFixed(2)}；重心 ${qComp.vertical} → ${comp.vertical}；不对称度 ${qComp.asymmetry.toFixed(3)} → ${comp.asymmetry.toFixed(3)}` },
        ],
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  // B4 局部视觉语言：只借色彩与光线
  const localRows = items
    .map((work) => {
      const c = colorProfile(work);
      if (!c || !qColor) return null;
      const dSat = Math.abs(c.sat - qColor.sat);
      const dCon = Math.abs(c.contrast - qColor.contrast);
      if (c.warmth !== qColor.warmth || dSat > 0.1 || dCon > 0.12) return null;
      const comp = compositionProfile(work);
      const structuralDiff = (comp && qComp && comp.bucket !== qComp.bucket) || subjectClass(work) !== qSubject;
      if (!structuralDiff) return null; // 结构也没换，就不算"只借局部"
      return {
        work, score: 3 - dSat * 10 - dCon * 5,
        preserves: `色彩关系与明暗组织相近（${c.warmth}、饱和度 ${c.sat.toFixed(2)} vs ${qColor.sat.toFixed(2)}、对比度 ${c.contrast.toFixed(2)} vs ${qColor.contrast.toFixed(2)}）`,
        changes: `主体与构图都换成别的：${SUBJECT_LABEL[subjectClass(work)]}${comp ? `、${BUCKET_LABEL[comp.bucket]}` : ""}`,
        evidence: [
          { kind: "像素实测", text: `暖度 ${qColor.warmthValue.toFixed(2)} → ${c.warmthValue.toFixed(2)}；饱和度差 ${dSat.toFixed(3)}；对比度差 ${dCon.toFixed(3)}` },
          { kind: kindOf(work) === "film" ? "跨媒介" : "档案", text: kindOf(work) === "film" ? `电影剧照（${work.year}），只借色彩与光，不借人物与叙事` : `档案描述：${(work.composition || "").slice(0, 40)}` },
        ],
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  const rowsByBranch = { subject: subjectRows, scene: sceneRows, composition: compRows, local: localRows };

  return BRANCHES.map((def) => {
    const rows = take(rowsByBranch[def.id] || [], def.id);
    const results = rows.map((r) => ({
      id: r.work.id,
      kind: kindOf(r.work),
      href: r.work.href,
      title: r.work.titleZh || r.work.title,
      artist: r.work.artistZh || r.work.artist || r.work.director || "",
      year: r.work.year,
      image: r.work.image,
      preserves: r.preserves,
      changes: r.changes,
      evidence: r.evidence,
      visionVerified: Boolean(VISION_PROFILES.profiles[r.work.id]),
    }));
    return {
      ...def,
      results,
      empty: results.length === 0,
      emptyReason: results.length === 0
        ? (emptyReason || `在「${def.changeDim}」这一维上没有找到同时满足「保留风格」的候选。`)
        : null,
      vision: visionNote(queryId, results),
    };
  }).map((b) => ({ ...b, mediaState: { mode: media, excluded } }));
}
