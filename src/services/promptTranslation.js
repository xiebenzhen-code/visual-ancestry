// Prompt Translation (R1.0-R2 Principle Selection) — deterministic, pure,
// no AI call, no model, no network. Given the current VisualIntent, the
// selected references (with their curated prompt data), the block-level
// Keep toggles and the user's explicit KEEP / REMOVE principle choices, it
// produces the layered creative prompt that CREATE finally hands over.
//
// Vocabulary source of truth: the provider schema's ENUM_FIELDS in
// server/vision/openaiProvider.mjs (identical to the validator's enum set,
// verified MATCH in the R1 audit). Only the subset CREATE needs for
// principle selection is mirrored here. This module does NOT create a second
// intent model: it reads the very same VisualIntent objects the retrieval
// layer produces, and it never writes them.
//
// Hard rules honoured in this file:
//   A — the current intent changes the copyable prompt body (constraint
//       lines), not just ordering or notes.
//   B — KEEP becomes a positive, executable requirement.
//   C — REMOVE becomes a negative, executable prohibition.
//   D — conflicts are resolved in favour of the user's explicit choice; the
//       conflicting reference dimension is dropped from the final prompt and
//       explained separately (never as a contradiction inside the prompt).
//   E — nothing is invented: every requirement comes from an explicit
//       template below or from curated artwork text; unmappable fields are
//       skipped with a recorded reason.
//   F — curated data is read-only. This module never mutates, writes back or
//       overrides creatorTranslation.aigc.

import { intentFromArtwork } from "./retrieval/artworkIntent.js";

// ---------------------------------------------------------------------------
// Vocabulary (mirrored from the provider schema enum fields)
// ---------------------------------------------------------------------------
export const PRINCIPLE_FIELDS = {
  negativeSpace: { label: "留白", values: ["high", "low"] },
  colorTemperature: { label: "色温", values: ["cool", "warm", "neutral"] },
  saturation: { label: "饱和度", values: ["low", "medium", "high"] },
  subjectScale: { label: "人物尺度", values: ["small", "medium", "large"] },
  environmentDominance: { label: "环境主导", values: ["high", "low"] },
  spatialDepth: { label: "空间纵深", values: ["deep", "shallow"] },
};

// Executable positive requirements, keyed by field → value. These are the
// ONLY creative requirements this module can emit from a field/value pair.
const REQUIREMENT = {
  negativeSpace: {
    high: "保留大面积负空间：主体与背景之间留出大面积空白，负空间在构图中占主导，不要把画面填满",
    low: "收紧缩凑构图：画面元素分布紧凑，背景不出现大面积空白区域",
  },
  colorTemperature: {
    cool: "整体色温偏冷：以冷灰、蓝、青为主色调，暖色不得主导画面",
    warm: "整体色温偏暖：以暖褐、金黄、黄昏色调为主",
    neutral: "色温保持中性：冷暖均衡，不做整体偏色",
  },
  saturation: {
    low: "低饱和处理：所有颜色保持灰调，降低纯度与对比",
    medium: "中等饱和：颜色有区分度但不过度鲜艳",
    high: "高饱和：使用鲜明纯色形成视觉锚点",
  },
  subjectScale: {
    small: "人物体量很小：主体显著小于环境，空间感压过人",
    medium: "人物体量中等：主体与环境比例均衡",
    large: "人物占画面比例很大：以人物本身为画面主角",
  },
  environmentDominance: {
    high: "环境主导画面：背景与空间关系承担主要叙事，人物不抢占视觉中心",
    low: "环境次要：背景信息收敛，注意力集中在主体",
  },
  spatialDepth: {
    deep: "纵深深远：画面包含前中后景层次，空间向远处延伸",
    shallow: "空间偏平面：压缩纵深，层次扁平化",
  },
};

// Executable negative prohibitions, keyed by field → value. A REMOVE emits
// one of these — never a silent deletion of keywords.
const PROHIBITION = {
  negativeSpace: {
    high: "禁止大面积留白：不要空旷背景与大面积空白，画面需被视觉元素填充",
    low: "禁止拥挤压缩：不要把画面塞满，至少保留一块干净空白",
  },
  colorTemperature: {
    warm: "排除暖色调：不要金色、橙黄、黄昏暖调，不要暖褐或暖肤色主导，整体保持冷灰或中性",
    cool: "排除冷色调：不要冷灰、青蓝色主导画面，避免整体冷调",
    neutral: "排除整体偏色：不要统一偏冷或偏暖，冷暖保持均衡",
  },
  saturation: {
    high: "排除高饱和：不要鲜艳纯色与强烈色彩对比",
    low: "排除低饱和：不要灰调或低饱和处理",
    medium: "排除统一中等饱和：饱和度需按主体明确偏高或偏低",
  },
  subjectScale: {
    small: "排除小人物构图：主体不得明显小于环境",
    medium: "排除中等体量构图：主体比例需明确偏小或偏大",
    large: "排除人物占满画面：主体需为环境让出空间",
  },
  environmentDominance: {
    high: "排除环境主导：背景不得压过人物，注意力必须回到主体",
    low: "排除环境次要：背景需承担叙事分量，不能仅作留白",
  },
  spatialDepth: {
    deep: "排除深远纵深：不要前中后景层次，压缩空间深度",
    shallow: "排除扁平空间：不要平面化处理，必须保留纵深",
  },
};

// Curated color text that actually carries a given color temperature.
// Used ONLY to decide whether a reference's curated colour line conflicts
// with an explicit colour choice; the emitted text is still the untouched
// curated string (never rewritten, never deleted in place).
const WARM_TEXT = /暖|金|橙|黄|赭|褐|烛|夕阳|黄昏/i;

// Vocabulary validation — the single gate writers must pass through.
export function validatePrinciple(entry) {
  if (!entry || typeof entry !== "object") return { ok: false, reason: "not-an-object" };
  const field = typeof entry.field === "string" ? entry.field.trim() : "";
  const value = typeof entry.value === "string" ? entry.value.trim() : "";
  const action = typeof entry.action === "string" ? entry.action.trim() : "";
  if (!field) return { ok: false, reason: "missing-field" };
  if (!value) return { ok: false, reason: "missing-value" };
  if (action !== "keep" && action !== "remove") return { ok: false, reason: "invalid-action" };
  const spec = PRINCIPLE_FIELDS[field];
  if (!spec) return { ok: false, reason: `unknown-field:${field}` };
  if (!spec.values.includes(value)) return { ok: false, reason: `illegal-value:${field}=${value}` };
  return { ok: true, reason: null };
}

export function describePrinciple(entry) {
  const spec = PRINCIPLE_FIELDS[entry.field];
  return `${spec.label} = ${entry.value} · ${entry.action === "keep" ? "KEEP" : "REMOVE"}`;
}

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------

// Block-level toggles → the curated aigc field they control. `color` has no
// aigc prompt field (confirmed: the curated set is scene / camera / lighting
// / composition / movement / negative), so Color System is satisfied by the
// curated `color` description — curated text, not generated.
const BLOCK_FIELDS = [
  { key: "spatial", label: "Composition Prompt", pick: (r) => r.aigc.compositionPrompt, dimension: "composition" },
  { key: "light", label: "Lighting Prompt", pick: (r) => r.aigc.lightingPrompt, dimension: "light" },
  { key: "camera", label: "Camera Prompt", pick: (r) => r.aigc.cameraPrompt, dimension: "camera" },
  { key: "human", label: "Scene Prompt", pick: (r) => r.aigc.scenePrompt, dimension: "scene" },
  { key: "color", label: "Color Prompt", pick: (r) => r.color, dimension: "colorTemperature" },
];

const UNCONDITIONAL_BLOCKS = [
  { label: "Movement Prompt", pick: (r) => r.aigc.movementPrompt },
  { label: "Negative Prompt", pick: (r) => r.aigc.negativePrompt },
];

function candidateIntentOf(artwork) {
  try {
    return intentFromArtwork(artwork);
  } catch {
    return null;
  }
}

/**
 * translatePrompt — the whole deterministic translation.
 *
 * @param {object|null} intent        current VisualIntent (may be null)
 * @param {Array}  references         [{ artwork, aigc, color }] in selection order
 * @param {Array}  principles         [{ field, value, action, sourceReferenceKey? }]
 * @param {object} blocks             { spatial, light, camera, human, color } booleans
 * @returns layered translation result
 */
export function translatePrompt({ intent = null, references = [], principles = [], blocks = {} } = {}) {
  const validPrinciples = [];
  const skipped = [];
  for (const entry of principles) {
    const check = validatePrinciple(entry);
    if (check.ok) validPrinciples.push(entry);
    else skipped.push({ kind: "principle", entry, reason: check.reason });
  }

  const enriched = references.map((ref) => ({
    ...ref,
    candidate: candidateIntentOf(ref.artwork),
  }));

  const conflicts = [];
  const isDropped = (ref, block) => {
    // Rule D: an explicit choice wins. When the user REMOVEs a colour
    // temperature the reference carries, that reference's curated colour
    // line is dropped from the final prompt (not silently trimmed) and the
    // drop is explained. When the user KEEPs the opposite temperature, the
    // reference's colour line likewise cannot demand the opposite.
    const forBlock = validPrinciples.filter((p) => p.field === block.dimension);
    if (!forBlock.length) return false;
    for (const principle of forBlock) {
      if (principle.action !== "remove") continue;
      if (block.dimension !== "colorTemperature") continue;
      const text = block.pick(ref) || "";
      const warmRemoved = principle.value === "warm";
      const derived = ref.candidate ? ref.candidate.colorTemperature : "";
      const derivedWarm = derived === "warm" || (derived && WARM_TEXT.test(text));
      if (warmRemoved && derivedWarm) {
        conflicts.push({
          kind: "reference-colour-dropped",
          reference: ref.artwork.id,
          artist: ref.artwork.artist,
          field: "colorTemperature",
          removedValue: "warm",
          curatedText: text,
          explanation: `《${ref.artwork.titleZh || ref.artwork.title}》的策展色温为暖（${text}），与你 REMOVE warm 冲突：该作品的暖色描述不再进入最终 Prompt，其余视觉原则保留。`,
        });
        return true;
      }
      if (principle.value === "cool" && derivedWarm) {
        conflicts.push({
          kind: "reference-colour-dropped",
          reference: ref.artwork.id,
          artist: ref.artwork.artist,
          field: "colorTemperature",
          removedValue: "cool",
          curatedText: text,
          explanation: `《${ref.artwork.titleZh || ref.artwork.title}》的策展色温为暖（${text}），与你 REMOVE cool 冲突：该作品的暖色描述不再进入最终 Prompt。`,
        });
        return true;
      }
    }
    return false;
  };

  // ---- Reference-derived principles (curated, block-filtered) --------------
  const referencePrinciples = [];
  for (const ref of enriched) {
    for (const block of BLOCK_FIELDS) {
      if (blocks[block.key] === false) continue;
      const text = block.pick(ref);
      if (!text) {
        skipped.push({ kind: "reference-block", reference: ref.artwork.id, block: block.key, reason: "curated-field-empty" });
        continue;
      }
      if (isDropped(ref, block)) continue;
      referencePrinciples.push({
        section: "reference",
        label: block.label,
        text,
        artist: ref.artwork.artist,
        reference: ref.artwork.id,
      });
    }
    for (const block of UNCONDITIONAL_BLOCKS) {
      const text = block.pick(ref);
      if (!text) continue;
      referencePrinciples.push({
        section: "reference",
        label: block.label,
        text,
        artist: ref.artwork.artist,
        reference: ref.artwork.id,
      });
    }
  }

  // ---- Current-intent constraints (rule A: real prompt-body lines) --------
  const intentConstraints = [];
  const removePairs = validPrinciples.filter((p) => p.action === "remove").map((p) => `${p.field}=${p.value}`);
  const keepPairs = validPrinciples.filter((p) => p.action === "keep").map((p) => `${p.field}=${p.value}`);
  if (intent) {
    for (const [field, spec] of Object.entries(PRINCIPLE_FIELDS)) {
      const value = intent[field];
      if (!value || !spec.values.includes(value)) {
        if (value) skipped.push({ kind: "intent-field", field, value, reason: "value-not-in-enum" });
        continue;
      }
      const pair = `${field}=${value}`;
      // An explicit REMOVE overrides an intent field asking for the same
      // thing — the user's explicit operation wins (rule D).
      if (removePairs.includes(pair)) {
        conflicts.push({
          kind: "intent-constraint-overridden",
          field,
          value,
          explanation: `当前意图要求 ${spec.label}=${value}，与你 REMOVE ${spec.label}=${value} 冲突：以你的显式移除为准，该意图约束不写入 Prompt。`,
        });
        continue;
      }
      if (keepPairs.includes(pair)) {
        // Same direction as an explicit KEEP — skip the duplicate line.
        continue;
      }
      intentConstraints.push({
        section: "intent",
        label: `${spec.label}（来自当前视觉意图）`,
        text: REQUIREMENT[field][value],
        field,
        value,
      });
    }
    for (const field of Object.keys(intent)) {
      if (PRINCIPLE_FIELDS[field]) continue;
      if (["source", "raw", "emotion", "atmosphere"].includes(field)) continue;
      if (!intent[field]) continue;
      skipped.push({ kind: "intent-field", field, value: intent[field], reason: "no-executable-template" });
    }
  }

  // ---- Explicit KEEP / REMOVE (rules B & C) -------------------------------
  const keepRequirements = [];
  const removeRequirements = [];
  for (const principle of validPrinciples) {
    const spec = PRINCIPLE_FIELDS[principle.field];
    if (principle.action === "keep") {
      keepRequirements.push({
        section: "keep",
        label: `KEEP · ${spec.label} = ${principle.value}`,
        text: REQUIREMENT[principle.field][principle.value],
        field: principle.field,
        value: principle.value,
        sourceReferenceKey: principle.sourceReferenceKey || null,
      });
    } else {
      removeRequirements.push({
        section: "remove",
        label: `REMOVE · ${spec.label} = ${principle.value}`,
        text: PROHIBITION[principle.field][principle.value],
        field: principle.field,
        value: principle.value,
        sourceReferenceKey: principle.sourceReferenceKey || null,
      });
    }
  }

  // ---- Final prompt: positives first, prohibitions last, no contradiction --
  const finalPrompt = [
    ...referencePrinciples.map((line) => ({ ...line, kind: "positive" })),
    ...intentConstraints.map((line) => ({ ...line, kind: "positive" })),
    ...keepRequirements.map((line) => ({ ...line, kind: "positive" })),
    ...removeRequirements.map((line) => ({ ...line, kind: "negative" })),
  ];

  return {
    referencePrinciples,
    intentConstraints,
    keepRequirements,
    removeRequirements,
    conflicts,
    skipped,
    finalPrompt,
  };
}

// Plain-text body for the clipboard / copy handler.
export function finalPromptText(result) {
  return result.finalPrompt.map((line) => `${line.label}：${line.text}`).join("\n");
}
