// P5.3.1 — visualProfilePresenter: turns profile DATA into Chinese sentences.
//
// The aggregator (visualProfile.js) never writes prose; this presenter never
// computes shares. Separation reason (P5.3.1 STEP 3): future UI changes,
// i18n, or portfolio views swap this file without touching the data layer.
//
// Honesty: the confidence level controls the voice — 19 assets can only say
// 「当前收藏还少，只是初步观察」, never 「你的审美就是」. Sections without a
// clear tendency (ratio < STRONG) render as 「未显现明显倾向」 instead of
// being faked into a claim.

const STRONG = 0.55; // ≥55% → 「较多/经常」
const WEAK = 0.4;    // 40-55% → 「接近半数」; <40% → no claim

// ---- confidence headline ----------------------------------------------------
export function confidenceHeadline(confidence) {
  switch (confidence.level) {
    case "empty":
      return {
        tone: "empty",
        text: "还没有可分析的视觉资产。",
        basis: "保存一些图片后，这里会出现你的收藏倾向。",
      };
    case "observation":
      return {
        tone: "observation",
        text: "当前收藏还少，以下是初步观察。",
        basis: confidence.basis,
      };
    case "tendency":
      return {
        tone: "tendency",
        text: "你的收藏开始显现稳定的倾向。",
        basis: confidence.basis,
      };
    case "pattern":
      return {
        tone: "pattern",
        text: "你的收藏已经形成清晰的视觉模式。",
        basis: confidence.basis,
      };
    default:
      return { tone: "observation", text: "当前样本显示：", basis: confidence.basis };
  }
}

// ---- one metric → sentence + fraction ---------------------------------------
// templated so each field can phrase its own natural sentence
const METRICS = [
  { group: "空间倾向", key: "deepSpace", get: (p) => p.spatial.deepSpace, strong: "收藏中较多作品使用深空间结构。", mid: "部分作品具有深空间结构。" },
  { group: "空间倾向", key: "environmentDominant", get: (p) => p.spatial.environmentDominant, strong: "环境常常压过画面中的人物。", mid: "环境在画面中占据主导的作品不少。" },
  { group: "空间倾向", key: "negativeSpaceHigh", get: (p) => p.spatial.negativeSpaceHigh, strong: "大量留白是你收藏里的常见结构。", mid: "有接近一半的收藏使用大量留白。" },
  { group: "构图倾向", key: "centeredSubject", get: (p) => p.composition.centeredSubject, strong: "主体多居于画面中心。", mid: "近半数作品的主体居于中心。" },
  { group: "构图倾向", key: "farCamera", get: (p) => p.composition.farCamera, strong: "你的收藏偏向远距离观察。", mid: "远景与中景在你的收藏里大致各半。" },
  { group: "构图倾向", key: "staticFrame", get: (p) => p.composition.staticFrame, strong: "静止画面占绝大多数，动态很少。", mid: "多数画面是静止的。" },
  { group: "色彩倾向", key: "lowSaturation", get: (p) => p.color.lowSaturation, strong: "低饱和色彩出现频率较高。", mid: "接近半数的收藏偏低饱和。" },
  { group: "色彩倾向", key: "highContrast", get: (p) => p.color.highContrast, strong: "高对比的光影关系反复出现。", mid: "高对比作品约占一半。" },
  { group: "人物关系", key: "isolation", get: (p) => p.narrative.isolation, strong: "许多作品中人物处于孤立的环境关系中。", mid: "孤立的人物关系约占一半。" },
  { group: "人物关系", key: "socialDistanceHigh", get: (p) => p.narrative.socialDistanceHigh, strong: "人与人之间保持着明显的距离感。", mid: "疏远的人际距离约占一半。" },
  { group: "人物关系", key: "quietArousal", get: (p) => p.narrative.quietArousal, strong: "画面整体是安静的、低唤醒的。", mid: "平静的画面约占一半。" },
];

function shareLine(metric, profile) {
  const s = metric.get(profile);
  if (s.ratio >= STRONG) {
    return { text: metric.strong, fraction: `${s.count} / ${profile.sampleSize}`, ratio: s.ratio };
  }
  if (s.ratio >= WEAK) {
    return { text: metric.mid, fraction: `${s.count} / ${profile.sampleSize}`, ratio: s.ratio };
  }
  return null; // no claim — honesty over completeness
}

// ---- main: profile → ordered sections for the page ---------------------------
export function profileSections(profile) {
  if (!profile || profile.sampleSize === 0) return [];
  const groups = [];
  for (const metric of METRICS) {
    let group = groups.find((g) => g.title === metric.group);
    if (!group) {
      group = { title: metric.group, lines: [], hasClaim: false };
      groups.push(group);
    }
    const line = shareLine(metric, profile);
    if (line) {
      group.lines.push(line);
      group.hasClaim = true;
    }
  }
  // groups without any claim render one honest line instead of disappearing
  for (const g of groups) {
    if (!g.hasClaim) g.lines.push({ text: "未显现明显倾向。", fraction: "", ratio: 0 });
  }
  return groups;
}

// ---- atmosphere block (sparse, always with coverage note) --------------------
export function atmosphereBlock(profile) {
  if (!profile || profile.sampleSize === 0) return null;
  const tokens = Object.entries(profile.atmosphereTokens || {}).sort((a, b) => b[1] - a[1]);
  if (!tokens.length) return null;
  const pct = Math.round(profile.atmosphereCoverage * 100);
  return {
    tokens: tokens.map(([token, count]) => ({ token, count })),
    note: `${pct}% 的收藏带氛围词，其余没有——这是当前识别能力的边界。`,
  };
}

// ---- unavailable block (honest list, verbatim from the aggregator) ----------
export function unavailableBlock(profile) {
  if (!profile) return [];
  return Object.entries(profile.unavailable || {}).map(([field, reason]) => ({ field, reason }));
}
