// visualSearch.js — P4.14-D STEP 3C 组合检索（实验层）
//
// 链路：图像向量召回 → 结构关系比较 → VisualIntent 补充解释 → Top N
//
// 三条纪律：
//   1. 只在实验里跑。生产 FIND 仍走 retrievalService，本模块不改它。
//   2. 余弦相似度**不是**艺术相关性。界面上必须同时给出「具体相似点」和「重要差异」，
//      而不是甩一个百分比。
//   3. 没有可信候选就返回少量或 0 条，不补足数量。

import embeddings from "../../data/visual-embeddings.json" with { type: "json" };
import { artworks } from "../../data/artworks.js";
import { structureFeatures, compareStructure } from "./structureFeatures.js";
import { intentForArtwork, MEDIA, filmStillPool } from "../retrieval/retrievalService.js";
import { describeMedia, VISUAL_FORM, IMAGE_KIND } from "../source/mediaTaxonomy.js";

export const EXPERIMENT_MODE = Object.freeze({
  OLD: "old",             // 现有 VisualIntent 排序（对照组）
  EMBEDDING: "embedding", // 纯向量
  COMBINED: "combined",   // 向量 + 结构
});

const ARTWORK_BY_ID = new Map(artworks.map((a) => [a.id, a]));
const FILM_BY_ID = new Map(
  filmStillPool().map((f) => [f.id || f.artwork?.id, f])
);

/** 组装实验图库：向量 + 记录 + 结构特征 + 四层媒介。只收有向量的条目。 */
function buildLibrary() {
  const out = [];
  for (const id of Object.keys(embeddings.vectors || {})) {
    const kind = embeddings.kinds[id] === "film" ? MEDIA.FILM : MEDIA.ARTWORK;
    const record = kind === MEDIA.FILM ? FILM_BY_ID.get(id) : ARTWORK_BY_ID.get(id);
    if (!record) continue;
    const intent = kind === MEDIA.FILM ? record.visualIntent : intentForArtwork(record);
    const media = describeMedia({ ...record, medium: kind, id });
    out.push({
      id,
      kind,
      record,
      intent,
      media,
      vector: embeddings.vectors[id],
      structure: structureFeatures(record, intent),
      title: record.titleZh || record.title,
      creator: record.artist || record.director || "",
      year: record.year || "",
    });
  }
  return out;
}

let LIBRARY = null;
export function library() {
  if (!LIBRARY) LIBRARY = buildLibrary();
  return LIBRARY;
}

/** 余弦相似度。向量在生成时已 L2 归一化，点积即余弦。 */
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/**
 * 合并候选池：基础 47 条 + 用户个人参考。
 *
 * 个人条目由服务端反序列化而来，形状必须与基础条目一致（vector/media/kind/title…）。
 * 这里只做合并与去重（同 id 优先个人），不做任何评分。
 */
export function pool(extraEntries = []) {
  const base = library();
  if (!Array.isArray(extraEntries) || !extraEntries.length) return base;
  const seen = new Set(extraEntries.map((e) => e.id));
  return [...extraEntries, ...base.filter((e) => !seen.has(e.id))];
}

/** 媒介过滤。动画目前没有数据，选了就是 0 条——这是事实，不是 bug。
 *  页面不再自己写一份：两份同名实现一旦分叉，就会一边筛一边不筛。 */
export function passMedia(entry, media) {
  if (!media || media === "all") return true;
  if (media === MEDIA.ARTWORK) return entry.kind === MEDIA.ARTWORK;
  // 「彩色电影」指真人实拍。动画的 medium 也是 film，若只看 kind，
  // 动画会被算进电影里——两类就混了。必须同时看 visualForm。
  if (media === MEDIA.FILM) {
    return entry.kind === MEDIA.FILM && entry.media.visualForm !== VISUAL_FORM.ANIMATION;
  }
  // anime 是 animation 的子集，不能等同于 animation：
  // 只声明 visualForm=animation 但没有 anime 传统的，不算日本动漫。
  // 这里直接看已经算好的 entry.media：isAnime() 会从原始字段重新推导，
  // 而库条目身上只有 media，重推会把 tradition 推丢。
  if (media === "anime") {
    return entry.media?.visualForm === VISUAL_FORM.ANIMATION && entry.media?.tradition === "anime";
  }
  if (media === VISUAL_FORM.ANIMATION) return entry.media.visualForm === VISUAL_FORM.ANIMATION;
  return true;
}

/**
 * 向量召回。
 *
 * @param {number[]} queryVector
 * @param {{media?:string, limit?:number, excludeId?:string, minSim?:number}} opts
 */
export function searchByEmbedding(queryVector, opts = {}) {
  const { media = "all", limit = 8, excludeId = "", minSim = 0, extraEntries = [] } = opts;
  if (!Array.isArray(queryVector) || !queryVector.length) {
    return { results: [], note: "没有可用的查询向量" };
  }
  const scored = [];
  for (const e of pool(extraEntries)) {
    if (excludeId && e.id === excludeId) continue;
    if (!passMedia(e, media)) continue;
    const sim = cosine(queryVector, e.vector);
    if (sim == null || sim < minSim) continue;
    scored.push({ ...e, similarity: Math.round(sim * 1000) / 1000 });
  }
  scored.sort((a, b) => b.similarity - a.similarity);
  return { results: scored.slice(0, limit), note: null };
}

/**
 * 组合检索：向量召回打底，结构关系参与排序，VisualIntent 只负责解释。
 *
 * 为什么结构不能单独决定排序：它只有 9 个可用维度，且其中 4 个来自同一份
 * VisualIntent——让它主导，等于换个方式回到老问题。这里向量占大头，
 * 结构只做「同分附近的重排」。
 */
export function searchCombined(queryVector, queryStructure, opts = {}) {
  const { media = "all", limit = 8, excludeId = "", minSim = 0.05, extraEntries = [] } = opts;
  const base = searchByEmbedding(queryVector, { media, limit: 40, excludeId, minSim, extraEntries });
  if (!base.results.length) return { results: [], note: base.note };

  const out = [];
  for (const r of base.results) {
    const cmp = queryStructure ? compareStructure(queryStructure, r.structure) : null;
    const structScore = cmp && cmp.score != null ? cmp.score : null;
    // 结构只在可比维度够多时才敢参与；不足 4 维就当没有这层证据。
    const useStruct = structScore != null && cmp.comparable >= 4;
    const combined = useStruct
      ? 0.72 * r.similarity + 0.28 * structScore
      : r.similarity;
    out.push({
      ...r,
      structureMatch: useStruct ? structScore : null,
      structureComparable: cmp ? cmp.comparable : 0,
      samePoints: cmp ? cmp.samePoints : [],
      differences: cmp ? cmp.differences : [],
      score: Math.round(combined * 1000) / 1000,
    });
  }
  out.sort((a, b) => b.score - a.score);
  return { results: out.slice(0, limit), note: null };
}

/** 纯结构排序（对照用）。 */
export function searchByStructure(queryStructure, opts = {}) {
  const { media = "all", limit = 8, excludeId = "", extraEntries = [] } = opts;
  if (!queryStructure) return { results: [], note: "没有结构特征" };
  const out = [];
  for (const e of pool(extraEntries)) {
    if (excludeId && e.id === excludeId) continue;
    if (!passMedia(e, media)) continue;
    const cmp = compareStructure(queryStructure, e.structure);
    if (!cmp || cmp.score == null) continue;
    out.push({
      ...e,
      structureMatch: cmp.score,
      structureComparable: cmp.comparable,
      samePoints: cmp.samePoints,
      differences: cmp.differences,
      score: cmp.score,
    });
  }
  out.sort((a, b) => b.score - a.score);
  return { results: out.slice(0, limit), note: null };
}

/** 这张图能用作参考吗？海报/宣传照不算「画面」。 */
export function referenceSuitability(entry) {
  const kind = entry.media.imageKind;
  if (kind === IMAGE_KIND.POSTER) return { ok: false, reason: "海报不是影片画面，不能当视觉参考" };
  if (kind === IMAGE_KIND.PUBLICITY_STILL || kind === IMAGE_KIND.PUBLICITY_PHOTO) {
    return { ok: true, reason: "宣传物料，但画面取自影片场景", caution: true };
  }
  return { ok: true, reason: null };
}

/** 给界面用的一句话媒介标签。 */
export function mediaLabel(entry) {
  const m = entry.media;
  const form = m.visualForm === VISUAL_FORM.ANIMATION ? "动画" : m.visualForm === VISUAL_FORM.LIVE_ACTION ? "真人电影" : "绘画";
  const trad = m.tradition ? ` · ${m.tradition}` : "";
  return `${form}${trad}`;
}

export const LIBRARY_META = {
  model: embeddings.model,
  license: embeddings.license,
  fit: embeddings.fit,
  dim: embeddings.dim,
  count: Object.keys(embeddings.vectors || {}).length,
  generatedAt: embeddings.generatedAt,
};
