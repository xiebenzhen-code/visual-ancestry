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
  // P4.4 — 补齐此前缺失的标签。缺标签会让 sharedReasons() 返回空数组，
  // 而 retrieveByIntent 要求 reasons.length > 0，于是「分数够但没文案」的
  // 候选被整体丢弃（实测：人群/城市等查询因此返回 0 条）。
  ["subject", {
    "single-figure": "单个主体",
    figure: "有人物",
    portrait: "肖像式构图",
    group: "多人同框",
    place: "以场所为主体",
    none: "无明确主体",
  }],
  ["humanRelation", { isolated: "人物彼此孤立", together: "人物相互陪伴", crowd: "人群密集" }],
  ["subjectScale", { small: "人物尺度很小", medium: "人物尺度中等", large: "人物占画面很大" }],
  ["environmentDominance", { high: "环境压过人物", low: "人物压过环境" }],
  ["spatialDepth", { deep: "纵深很深", shallow: "空间偏平面" }],
  ["negativeSpace", { high: "留白很大", low: "几乎不留白" }],
  ["lightDirection", { side: "单方向侧光", back: "逆光轮廓", front: "正面光", top: "顶光" }],
  ["lightQuality", { diffuse: "光是散的", directional: "光有明确方向" }],
  ["saturation", { low: "饱和度偏低", medium: "饱和度适中", high: "饱和度高" }],
  ["contrast", { high: "明暗对比强", medium: "明暗对比适中", low: "明暗对比柔和" }],
  ["cameraRelation", { observational: "观看距离偏远，像旁观", immersive: "视角贴近，有沉浸感", confrontational: "正面直视观者" }],
  ["cameraDistance", { far: "机位离主体很远", medium: "机位距离中等", near: "机位离主体很近" }],
  ["socialDistance", { high: "人和环境之间距离很远", medium: "人际距离中等", low: "人际距离很近" }],
  ["motion", { still: "画面几乎静止", moving: "画面有运动感" }],
  ["visualDensity", { sparse: "信息密度低", dense: "信息密度高" }],
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
