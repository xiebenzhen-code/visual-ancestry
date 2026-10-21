// normalize.mjs — 把六类来源的原始结果压成同一条记录。
//
// 统一字段（缺失就写 null 并进 missing，不猜）：
//   provider providerId title creator year medium imageKind
//   imageUrl thumbnailUrl sourceUrl rightsStatus license width height fetchedAt
//
// imageKind 是硬约束：海报、宣传背景、剧集剧照、目录封面不能互相冒充。

export const IMAGE_KINDS = Object.freeze({
  ARTWORK: "artwork",
  FILM_STILL: "film-still",
  TV_EPISODE_STILL: "tv-episode-still",
  PROMOTIONAL_BACKDROP: "promotional-backdrop",
  POSTER: "poster",
  ANIME_COVER: "anime-cover",
  PHOTOGRAPH: "photograph",
  UNKNOWN: "unknown",
});

const str = (v) => (typeof v === "string" ? v.trim() : "");

/**
 * @param {object} raw 来源原始记录（各 provider 自己负责映射到这里）
 * @param {{provider:string, query?:string}} meta
 */
export function normalize(raw, meta) {
  const rec = {
    provider: meta.provider,
    providerId: String(raw.providerId ?? raw.id ?? "").trim(),
    title: str(raw.title) || null,
    creator: str(raw.creator) || null,
    year: str(raw.year) || null,
    medium: str(raw.medium) || null,
    imageKind: raw.imageKind || IMAGE_KINDS.UNKNOWN,
    imageUrl: str(raw.imageUrl) || null,
    thumbnailUrl: str(raw.thumbnailUrl) || str(raw.imageUrl) || null,
    sourceUrl: str(raw.sourceUrl) || null,
    rightsStatus: str(raw.rightsStatus) || null,
    license: str(raw.license) || null,
    width: Number(raw.width) > 0 ? Number(raw.width) : null,
    height: Number(raw.height) > 0 ? Number(raw.height) : null,
    fetchedAt: new Date().toISOString(),
    query: meta.query || null,
    origin: str(raw.origin) || null,
    missing: [],
  };
  if (!rec.providerId) rec.missing.push("providerId");
  if (!rec.title) rec.missing.push("title");
  if (!rec.creator) rec.missing.push("creator");
  if (!rec.year) rec.missing.push("year");
  if (!rec.medium) rec.missing.push("medium");
  if (!rec.imageUrl) rec.missing.push("imageUrl");
  if (!rec.sourceUrl) rec.missing.push("sourceUrl");
  if (!rec.rightsStatus && !rec.license) rec.missing.push("rights");
  if (!rec.width || !rec.height) rec.missing.push("dimensions");
  rec.id = `${rec.provider}:${rec.providerId}`;
  return rec;
}

/** 能不能进公开图片墙 / 视觉索引：必须有真图、尺寸、来源链接、权利信息。 */
export function isPublishable(rec) {
  // 尺寸允许为空：validate-image 会读真实字节回填。图、来源链接、权利声明必须先有。
  return Boolean(rec.imageUrl && rec.thumbnailUrl && rec.sourceUrl && (rec.rightsStatus || rec.license));
}

/** 是否可以作为"动画画面"参与视觉参考——目录封面一律不行。 */
export function isAnimationFrame(rec) {
  return rec.imageKind === IMAGE_KINDS.TV_EPISODE_STILL || rec.imageKind === IMAGE_KINDS.FILM_STILL;
}
