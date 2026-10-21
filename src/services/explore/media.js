// media.js — 探索分支的媒介筛选。
//
// 规则来自产品要求，不来自推测：
//   · 不限 / 绘画 / 彩色电影 / 动画 / 跨媒介
//   · **黑白电影不得作为 AIGC 视觉参考**——不是"排后"，是不进结果。
//   · 动画没有素材时给空状态，不是空白。
//
// 黑白判定复用已有的像素阈值（colorSignatureBrowser.js 用 saturation < 0.06
// 判"黑白/近黑白影像"）。这里不另造阈值，避免两处口径打架。

import { filmStills as RAW_STILLS } from "../../data/filmStills.js";
import { VISUAL_METRICS } from "../../data/visual-metrics.js";

export const MONOCHROME_SAT = 0.06;

export const MEDIA_MODES = [
  { value: "all", label: "不限" },
  { value: "artwork", label: "绘画" },
  { value: "film", label: "彩色电影" },
  { value: "animation", label: "动画" },
  { value: "cross", label: "跨媒介" },
];

export function metricsOf(id) {
  return VISUAL_METRICS.entries[id] || null;
}

export function kindOf(entry) {
  return entry && entry.kind === "film" ? "film" : "artwork";
}

/** 黑白（或近黑白）影像。没有实测数据的一律不算黑白——不猜。 */
export function isMonochrome(entry) {
  const m = entry.metrics || metricsOf(entry.id);
  if (!m || typeof m.meanSat !== "number") return false;
  return m.meanSat < MONOCHROME_SAT;
}

/** 能不能当 AIGC 创作参考。黑白电影永远不能。 */
export function allowedAsReference(entry) {
  if (kindOf(entry) === "film" && isMonochrome(entry)) return false;
  return Boolean(entry && entry.image);
}

export function filmStills() {
  return (Array.isArray(RAW_STILLS) ? RAW_STILLS : RAW_STILLS.stills || []).map((s) => ({
    id: s.id,
    kind: "film",
    title: s.title,
    titleZh: s.titleZh,
    year: s.year,
    director: s.director,
    image: s.image,
    metrics: metricsOf(s.id),
    traditions: s.traditions || [],
    emotion: s.emotion || [],
    atmosphere: s.atmosphere || [],
    visualDNA: s.visualDNA || [],
    composition: s.composition || "",
    lighting: s.lighting || "",
    color: s.color || "",
    spatialStructure: s.spatialStructure || "",
    href: `#film/${s.id}`,
  }));
}

/**
 * 按媒介筛选。返回的 items 已剔除黑白电影；excluded 只用于界面说明，
 * 不参与"为什么没有结果"的含糊表述。
 */
export function filterByMedia(pool, mode = "all", queryKind = "artwork") {
  const items = [];
  let monoFilms = 0;
  let noImage = 0;
  for (const entry of pool) {
    if (!allowedAsReference(entry)) {
      if (kindOf(entry) === "film" && isMonochrome(entry)) monoFilms += 1;
      else noImage += 1;
      continue;
    }
    const kind = kindOf(entry);
    let keep = false;
    if (mode === "all") keep = true;
    else if (mode === "artwork") keep = kind === "artwork";
    else if (mode === "film") keep = kind === "film";
    else if (mode === "animation") keep = kind === "animation";
    else if (mode === "cross") keep = kind !== queryKind;
    if (keep) items.push(entry);
  }
  return {
    items,
    excluded: { monochromeFilms: monoFilms, noImage },
    emptyReason: emptyReasonFor(mode, items.length, monoFilms),
  };
}

function emptyReasonFor(mode, count) {
  if (count > 0) return null;
  if (mode === "animation") return "库里还没有动画素材。这一档是空的，不是没加载出来。";
  if (mode === "film") return "没有可用的彩色电影画面。黑白影片不作为视觉参考，已排除。";
  if (mode === "cross") return "没有可用的跨媒介画面。黑白电影不作为 AIGC 视觉参考，因此不在这里凑数。";
  return "没有符合条件的候选。";
}
