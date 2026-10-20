// personal-entries.mjs — 把个人图库记录转成检索条目（与页面同一套字段映射）
//
// 页面有自己的一份；服务端多模态链路也需要同一份，否则 C 列排序与这里会分叉。

/** 用实测宽高构造结构特征；缺的维度如实留空，不猜。 */
export function structureFromRecord(rec) {
  const w = rec.width || 0, h = rec.height || 0;
  const aspect = w > 0 && h > 0 ? Math.round((w / h) * 1000) / 1000 : null;
  const orientation = aspect == null ? null : aspect > 1.08 ? "landscape" : aspect < 0.92 ? "vertical" : "square";
  return {
    id: rec.id,
    aspect: { aspect, orientation, label: null, source: aspect == null ? "unavailable" : "measured-pixels" },
    figure: { subject: null, scale: null, relation: null, count: null, source: "unavailable" },
    space: { depth: null, environmentDominance: null, negativeSpace: null, source: "unavailable" },
    tone: { lightness: null, saturation: null, warmth: null, source: "unavailable" },
    unavailable: ["arrangement", "occlusion", "props", "figureCount", "subject", "depth", "tone"],
    sources: {},
  };
}

export function asEntry(item) {
  return {
    id: item.id,
    hash: item.hash,
    kind: item.kind || "artwork",
    personal: true,
    vector: item.vector,
    media: {
      medium: item.media?.medium || "artwork",
      visualForm: item.media?.visualForm || "still-image",
      tradition: item.media?.tradition || null,
      imageKind: item.media?.imageKind || "artwork-reproduction",
    },
    structure: structureFromRecord(item),
    title: item.title || item.id,
    creator: item.creator || "",
    year: item.year || "",
    record: { id: item.id, title: item.title, artist: item.creator, year: item.year, source: item.source },
  };
}
