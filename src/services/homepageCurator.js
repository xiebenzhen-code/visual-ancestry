// Homepage curator — 首页图片墙的选片器（不是随机墙）。
//
// 池子分两层，顺序即优先级：
//   1) QUALITY_IDS —— 产品里反复出现的重点作品（人工挑选）；
//   2) 档案里其余「本来就有本地图像」的作品 —— 按数据顺序补位，
//      用来把桌面首屏密度抬到 12–16 件。
//
// 约束（与产品要求一致）：
//   · 只用已有可用图像：image 存在、ratio 已知、imageUnavailable 不为真；
//   · 不引入新图、不改写图片；480/960/1920 三档由既有管线提供，
//     墙上的显示宽度远小于 480 档，所以不存在「放大低清图」；
//   · 结果按天轮换起点，但同一天的选片完全确定（可复现）；
//   · 竖图 / 横图 / 方图分桶后交替上场 —— 否则一列竖图会把首屏吃光，
//     密度靠的是交替，不是把图缩小。
import { artworks } from "../data/artworks.js";

const QUALITY_IDS = [
  "wanderer",
  "monk-by-sea",
  "wave",
  "nighthawks",
  "starry",
  "pearl",
  "hasui-zojoji-snow",
  "fan-kuan-travelers",
  "calling",
  "the-kiss",
  "hiroshige-shower",
  "waterlilies",
];

// Phase 1：首屏必须三类画面各有一件——装饰性/人物、城市/建筑、中国山水。
// 否则"从首页点进某类作品"这条路要靠当天轮换的运气，产品路径就不成立。
// 这三件只是首批锚点，不参与后面的轮换评分。
const HOME_ANCHORS = ["american-gothic", "paris-rainy-day", "fan-kuan-travelers"];

// h/w：> 1.15 明显竖图，< 0.85 明显横图，中间算方图。
const RATIO_TALL = 1.15;
const RATIO_WIDE = 0.85;

function usable(artwork) {
  return Boolean(artwork && artwork.image && artwork.image.ratio && !artwork.imageUnavailable);
}

function pool() {
  const quality = QUALITY_IDS.map((id) => artworks.find((artwork) => artwork.id === id)).filter(usable);
  const seen = new Set(quality.map((artwork) => artwork.id));
  const rest = artworks.filter((artwork) => usable(artwork) && !seen.has(artwork.id));
  return quality.concat(rest);
}

function bucketOf(artwork) {
  const ratio = artwork.image.ratio;
  if (ratio > RATIO_TALL) return "tall";
  if (ratio < RATIO_WIDE) return "wide";
  return "square";
}

export function curateHomepage(count = 4) {
  const works = pool();
  if (works.length <= count) return works;

  // 锚点优先占位（三类画面各一），其余按既有分桶轮换补齐。
  const pinned = HOME_ANCHORS.map((id) => works.find((w) => w.id === id)).filter(usable);
  const pinnedIds = new Set(pinned.map((w) => w.id));
  const rest = works.filter((w) => !pinnedIds.has(w.id));
  const remaining = Math.max(0, count - pinned.length);
  if (!remaining) return pinned.slice(0, count);

  const start = Math.floor(Date.now() / 86400000) % Math.max(1, rest.length);
  const rotated = rest.slice(start).concat(rest.slice(0, start));

  const buckets = { tall: [], wide: [], square: [] };
  for (const artwork of rotated) buckets[bucketOf(artwork)].push(artwork);

  const order = ["tall", "wide", "square"];
  const picked = [...pinned];
  let step = 0;
  while (picked.length < count && step < count * 3 + 12) {
    const list = buckets[order[step % order.length]];
    if (list.length) picked.push(list.shift());
    step += 1;
  }
  return picked.slice(0, count);
}
