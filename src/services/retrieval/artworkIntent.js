// Derive a VisualIntent from a curated artwork's existing analysis.
// Only fields we can justify from stored text are filled. No invented scores.
import { emptyVisualIntent, mergeIntent } from "./visualIntent.js";

function has(text, pattern) {
  return pattern.test(String(text || ""));
}

export function intentFromArtwork(artwork) {
  if (!artwork) return emptyVisualIntent();
  const blob = [
    artwork.composition,
    artwork.spatialStructure,
    artwork.lighting,
    artwork.color,
    artwork.oneLine,
    ...(artwork.visualDNA || []),
    ...(artwork.emotion || []),
    ...(artwork.atmosphere || []),
    artwork.creatorTranslation?.cinematic?.shotSize,
    artwork.creatorTranslation?.cinematic?.cameraHeight,
    artwork.creatorTranslation?.cinematic?.lightDirection,
    artwork.creatorTranslation?.cinematic?.subjectPlacement,
  ]
    .filter(Boolean)
    .join(" ");

  const patch = {
    emotion: artwork.emotion || [],
    atmosphere: artwork.atmosphere || [],
    source: "artwork",
  };

  if (has(blob, /很小|渺小|被.*吞没|tiny|small figure|远/)) {
    patch.subjectScale = "small";
    patch.environmentDominance = "high";
    patch.cameraDistance = "far";
    patch.cameraRelation = "observational";
  } else if (has(blob, /特写|半身|肖像|close|portrait/)) {
    patch.subjectScale = "large";
    patch.cameraDistance = "near";
    patch.subject = "portrait";
  } else if (has(blob, /人物|人/)) {
    patch.subjectScale = "medium";
    patch.subject = "figure";
  }

  if (has(blob, /纵深|深远|层层|deep|reced/)) patch.spatialDepth = "deep";
  if (has(blob, /平面|扁平|flat/)) patch.spatialDepth = "shallow";
  if (has(blob, /留白|大面积|空|negative|void|雾/)) {
    patch.negativeSpace = "high";
    patch.visualDensity = "sparse";
  }
  if (has(blob, /侧光|斜光|side/)) patch.lightDirection = "side";
  if (has(blob, /逆光|背光|back/)) patch.lightDirection = "back";
  if (has(blob, /散射|雾|柔|diffuse|soft/)) patch.lightQuality = "diffuse";
  if (has(blob, /低饱和|灰|素|muted|ink|水墨/)) patch.saturation = "low";
  if (has(blob, /高对比|明暗|chiaroscuro/)) patch.contrast = "high";
  if (has(blob, /冷|蓝|夜/)) patch.colorTemperature = "cool";
  if (has(blob, /暖|金|黄昏/)) patch.colorTemperature = "warm";
  if (has(blob, /低机位|仰/)) patch.cameraHeight = "low";
  if (has(blob, /高机位|俯/)) patch.cameraHeight = "high";
  if (has(blob, /静止|凝/)) {
    patch.motion = "still";
    patch.arousal = "low";
  }
  if ((artwork.emotion || []).includes("孤独") || has(blob, /独处|孤立/)) {
    patch.socialDistance = "high";
    patch.humanRelation = "isolated";
  }

  return mergeIntent(emptyVisualIntent(), patch);
}

const REASON_LABELS = [
  ["subjectScale", { small: "人物尺度很小", medium: "人物尺度中等", large: "人物占画面很大" }],
  ["environmentDominance", { high: "环境压过人物" }],
  ["spatialDepth", { deep: "纵深很深", shallow: "空间偏平面" }],
  ["negativeSpace", { high: "留白很大" }],
  ["lightDirection", { side: "单方向侧光", back: "逆光轮廓" }],
  ["lightQuality", { diffuse: "光是散的", directional: "光有明确方向" }],
  ["saturation", { low: "饱和度偏低" }],
  ["contrast", { high: "明暗对比强" }],
  ["cameraRelation", { observational: "观看距离偏远，像旁观" }],
  ["cameraDistance", { far: "机位离主体很远", near: "机位离主体很近" }],
  ["socialDistance", { high: "人和环境之间距离很远" }],
  ["motion", { still: "画面几乎静止" }],
  ["visualDensity", { sparse: "信息密度低" }],
];

export function sharedReasons(queryIntent, candidateIntent, limit = 4) {
  const reasons = [];
  for (const [field, labels] of REASON_LABELS) {
    const q = queryIntent[field];
    const c = candidateIntent[field];
    if (!q || !c || q !== c) continue;
    if (labels[q]) reasons.push(labels[q]);
    if (reasons.length >= limit) break;
  }
  return reasons;
}
