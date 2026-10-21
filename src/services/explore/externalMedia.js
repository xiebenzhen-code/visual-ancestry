// externalMedia.js — 外部候选的媒介规则（与本地候选同一套口径）。
//
// 单列成模块的原因：这条规则要被页面用、被测试钉住。写在页面里就只能靠点浏览器验证。
// 黑白影像不得作为参考：阈值复用 media.js 的 MONOCHROME_SAT（0.06），不另造一个。

import { MONOCHROME_SAT } from "./media.js";

export function saturationOf(item) {
  const sat = item && item.metrics && item.metrics.meanSat;
  return typeof sat === "number" ? sat : null;
}

export function isMonochromeItem(item) {
  const sat = saturationOf(item);
  return sat !== null && sat < MONOCHROME_SAT;
}

/**
 * @param {object} item 外部候选（含 imageKind / metrics）
 * @param {string} mode all | artwork | film | animation | cross
 */
export function matchesMedia(item, mode) {
  if (mode === "all") return true;
  const kind = (item && item.imageKind) || "unknown";
  if (mode === "artwork") return kind === "artwork";
  if (mode === "film") return (kind === "film-still" || kind === "tv-episode-still") && !isMonochromeItem(item);
  if (mode === "animation") return (kind === "animation-frame" || kind === "tv-episode-still") && !isMonochromeItem(item);
  if (mode === "cross") return kind !== "artwork";
  return true;
}

/** 一组候选中该媒介可见的数量。 */
export function countVisible(items, mode) {
  return (items || []).filter((i) => matchesMedia(i, mode)).length;
}
