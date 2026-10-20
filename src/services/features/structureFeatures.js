// structureFeatures.js — P4.14-D STEP 3A 结构关系特征
//
// 目的：补上 VisualIntent 量不到的维度。22 键仍然是**语义解释层**，这里只加一层
// 独立的结构特征，不改契约、不改评分器。
//
// 一条原则（任务书原文）：**使用真实可取得的数据；无法可靠识别的字段留空。**
// 所以每个维度都带 `source`，拿不到就写 `null` 并列入 `unavailable`，
// 绝不用「看起来像」去补。

import imageMetrics from "../../data/image-metrics.json" with { type: "json" };
import colorSignatures from "../../data/color-signatures.json" with { type: "json" };

const SIGS = (colorSignatures && colorSignatures.signatures) || {};

/** 画幅方向：横 / 竖 / 方。优先用实测宽高比，退化到 orientation 字段。 */
const ORIENTATION_LABEL = {
  landscape: "横幅",
  vertical: "立轴",
  portrait: "肖像（竖）",
  square: "方形",
};

function round(n, d = 3) {
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

/** 从实测尺寸推方向；没有尺寸时用记录里的 orientation 字段。 */
function aspectDimension(record) {
  const m = imageMetrics[record.id];
  if (m && m.w > 0 && m.h > 0) {
    const aspect = round(m.w / m.h);
    const orientation = aspect > 1.08 ? "landscape" : aspect < 0.92 ? "vertical" : "square";
    return { aspect, orientation, label: ORIENTATION_LABEL[orientation], source: "measured-pixels" };
  }
  if (record.orientation && ORIENTATION_LABEL[record.orientation]) {
    return {
      aspect: null,
      orientation: record.orientation,
      label: ORIENTATION_LABEL[record.orientation],
      source: "record-field",
    };
  }
  return { aspect: null, orientation: null, label: null, source: "unavailable" };
}

/** 人物侧：数量级 / 尺度 / 相互关系的粗粒度，来自 VisualIntent（不新增推断）。 */
function figureDimension(intent) {
  if (!intent) return { subject: null, scale: null, relation: null, source: "unavailable" };
  const subject = intent.subject || null;
  // 只用「有明确取值」的字段；缺就是 null。
  return {
    subject,
    scale: intent.subjectScale || null,
    relation: intent.humanRelation || null,
    // 人数是 VisualIntent 没有的维度。这里如实标空，不猜。
    count: null,
    source: subject ? "visual-intent" : "unavailable",
  };
}

/** 空间侧：纵深 / 环境主导 / 留白。 */
function spaceDimension(intent) {
  if (!intent) return { depth: null, environmentDominance: null, negativeSpace: null, source: "unavailable" };
  return {
    depth: intent.spatialDepth || null,
    environmentDominance: intent.environmentDominance || null,
    negativeSpace: intent.negativeSpace || null,
    source: intent.spatialDepth ? "visual-intent" : "unavailable",
  };
}

/** 影调侧：从既有色彩签名的主色加权得到明度与饱和度，再判冷暖。 */
function toneDimension(record) {
  const sig = SIGS[record.id];
  const dom = sig && sig.colorSignature && sig.colorSignature.dominant;
  if (!Array.isArray(dom) || !dom.length) {
    return { lightness: null, saturation: null, warmth: null, source: "unavailable" };
  }
  let l = 0, s = 0, wsum = 0, warm = 0, cool = 0;
  for (const c of dom) {
    const share = Number(c.share) || 0;
    const hsl = c.hsl || {};
    const h = Number(hsl.h);
    if (Number.isFinite(hsl.l)) l += hsl.l * share;
    if (Number.isFinite(hsl.s)) s += hsl.s * share;
    wsum += share;
    if (Number.isFinite(h)) {
      // 暖色约在 0–70° 与 330–360°，冷色约在 180–270°。
      if (h < 70 || h > 330) warm += share;
      else if (h >= 180 && h <= 270) cool += share;
    }
  }
  if (!wsum) return { lightness: null, saturation: null, warmth: null, source: "unavailable" };
  const warmth = warm > cool * 1.5 ? "warm" : cool > warm * 1.5 ? "cool" : "neutral";
  return {
    lightness: round(l / wsum),
    saturation: round(s / wsum),
    warmth,
    source: "color-signature",
  };
}

/**
 * 提取一条记录的结构特征。
 *
 * @param {object} record  绘画或影片记录
 * @param {object} [intent] 该记录的 VisualIntent（可传，避免重复查缓存）
 */
export function structureFeatures(record, intent = null) {
  if (!record || !record.id) return null;
  const aspect = aspectDimension(record);
  const figure = figureDimension(intent);
  const space = spaceDimension(intent);
  const tone = toneDimension(record);

  const unavailable = [];
  // 任务书点名但当前数据无法可靠识别的维度，如实留空。
  unavailable.push("arrangement"); // 横排 / 并列 / 叠置：无可靠字段
  unavailable.push("occlusion"); // 遮挡与层数：无可靠字段
  unavailable.push("props"); // 前景道具：只有策展散文，未结构化
  if (figure.count === null) unavailable.push("figureCount");
  if (aspect.aspect === null) unavailable.push("exactAspect");

  return {
    id: record.id,
    aspect,
    figure,
    space,
    tone,
    unavailable,
    // 记录每个维度从哪来，便于审计「这是猜的还是量的」
    sources: {
      aspect: aspect.source,
      figure: figure.source,
      space: space.source,
      tone: tone.source,
    },
  };
}

/** 单维度比较，返回 0..1；任一缺失返回 null（不参与，而不是当 0 分）。 */
function cmpEnum(a, b) {
  if (a == null || b == null) return null;
  return a === b ? 1 : 0;
}

function cmpNumber(a, b, tolerance) {
  if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b)) return null;
  const d = Math.abs(a - b);
  return d <= tolerance ? 1 : Math.max(0, 1 - d / (tolerance * 3));
}

function cmpAspect(a, b) {
  if (!a || !b || a.aspect == null || b.aspect == null) return null;
  // 用对数比：0.5 与 1.0 的差别，和 2.0 与 4.0 的差别应当一样大。
  const ratio = Math.abs(Math.log(a.aspect) - Math.log(b.aspect));
  return Math.max(0, 1 - ratio / Math.log(2.2));
}

/**
 * 结构相似度。返回逐维明细与加权总分，便于在界面上写出「具体相似点 / 重要差异」。
 *
 * 权重只用来说明「哪一维更像」，不是艺术相关性的真值。
 */
export function compareStructure(a, b) {
  if (!a || !b) return { score: null, parts: [], comparable: 0 };
  const parts = [];
  const push = (name, label, v, weight, same, diff) => {
    if (v == null) {
      parts.push({ name, label, value: null, weight, note: "该维度缺证据，不参与" });
      return;
    }
    parts.push({ name, label, value: v, weight, same: v >= 0.75 ? same : null, diff: v < 0.5 ? diff : null });
  };

  push("orientation", "画幅方向", cmpEnum(a.aspect.orientation, b.aspect.orientation), 1.2, "画幅方向一致", "一幅横、一幅竖");
  push("aspect", "画幅比例", cmpAspect(a.aspect, b.aspect), 1.0, "画幅比例接近", "画幅比例差得远");
  push("subject", "人物数量级", cmpEnum(a.figure.subject, b.figure.subject), 1.0, "主体类型一致", "主体类型不同");
  push("scale", "人物尺度", cmpEnum(a.figure.scale, b.figure.scale), 0.8, "人物占画比例接近", "人物占画比例不同");
  push("relation", "人物关系", cmpEnum(a.figure.relation, b.figure.relation), 0.6, "人物关系同类", "人物关系不同");
  push("depth", "空间纵深", cmpEnum(a.space.depth, b.space.depth), 0.9, "纵深接近", "纵深不同");
  push("env", "环境主导", cmpEnum(a.space.environmentDominance, b.space.environmentDominance), 0.7, "环境与人物比重接近", "环境比重不同");
  push("lightness", "明暗", cmpNumber(a.tone.lightness, b.tone.lightness, 0.15), 0.7, "整体明暗接近", "整体明暗差得多");
  push("saturation", "饱和度", cmpNumber(a.tone.saturation, b.tone.saturation, 0.12), 0.6, "色彩浓淡接近", "色彩浓淡不同");
  push("warmth", "冷暖", cmpEnum(a.tone.warmth, b.tone.warmth), 0.6, "冷暖倾向一致", "冷暖倾向相反");

  let sum = 0, wsum = 0, comparable = 0;
  for (const p of parts) {
    if (p.value == null) continue;
    comparable++;
    sum += p.value * p.weight;
    wsum += p.weight;
  }
  return {
    score: wsum > 0 ? round(sum / wsum) : null,
    parts,
    comparable,
    samePoints: parts.filter((p) => p.same).map((p) => p.same),
    differences: parts.filter((p) => p.diff).map((p) => p.diff),
  };
}
