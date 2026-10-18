// Shoot Translation (R1.0-R4, RC-5) — deterministic, pure, no AI call.
//
// Turns the live task (current VisualIntent + the user's explicit KEEP /
// REMOVE principles) into photography decisions a person can actually carry
// out on location, for the artwork currently open in SHOOT.
//
// Why this is a separate module instead of reusing promptTranslation.js:
//   1. Different output language. translatePrompt() emits AIGC image-prompt
//      text ("a solitary figure seen from behind…", negative prompts). Those
//      are model-facing descriptions, NOT instructions for a person standing
//      on location. Reusing them would be exactly the "copy the CREATE prompt
//      into SHOOT" anti-pattern.
//   2. Different input contract. SHOOT needs the current artwork, its curated
//      shooting guides and its confirmed visual relations — not references'
//      aigc fields.
//   3. Different vocabulary. Photography needs 18 intent fields that carry
//      reliable on-set meaning; promptTranslation deliberately covers only 6.
//
// Hard rules honoured here:
//   · Nothing invented. Every decision line comes from an explicit template
//     keyed by (field, value) pairs that exist in the VisualIntent enums, or
//     from curated artwork text. No focal lengths, no apertures, no distances,
//     no locations, no gear models — those numbers are the curation's to
//     state (personGuide.distance / phoneLens / time), never ours.
//   · Absence is preferred to invention. A decision group with no reliable
//     input is omitted and recorded in `skipped` with a reason.
//   · Provenance on every line. Each line names the source it came from.
//   · REMOVE wins. An explicit removal blocks the conflicting positive
//     requirement and contributes a negative on-set constraint instead.
//   · Visual parallel is not historical influence. Relation-backed notes are
//     labelled with their evidence class; THEMATIC parallels never become
//     shooting instructions.

import { validatePrinciple } from "./promptTranslation.js";

// ---------------------------------------------------------------------------
// Vocabulary + templates
// ---------------------------------------------------------------------------

// Fields with reliable on-set meaning. Keys mirror the VisualIntent enums in
// server/vision/openaiProvider.mjs. No schema is extended here.
export const SHOOT_FIELDS = {
  subject: ["single-figure", "figure", "portrait", "group", "place", "none"],
  subjectScale: ["small", "medium", "large"],
  subjectPosition: ["low", "center", "high", "edge"],
  environmentDominance: ["high", "low"],
  negativeSpace: ["high", "low"],
  spatialDepth: ["deep", "shallow"],
  visualDensity: ["sparse", "dense"],
  cameraDistance: ["far", "medium", "near"],
  cameraHeight: ["low", "eye", "high"],
  cameraRelation: ["observational", "immersive", "confrontational"],
  motion: ["still", "moving"],
  humanRelation: ["isolated", "together", "crowd"],
  socialDistance: ["low", "medium", "high"],
  lightDirection: ["side", "back", "front", "top"],
  lightQuality: ["diffuse", "directional", "rim"],
  colorTemperature: ["cool", "warm", "neutral"],
  saturation: ["low", "medium", "high"],
  contrast: ["low", "medium", "high"],
};

// Which decision group each field feeds.
const GROUP_OF = {
  subject: "framing",
  subjectScale: "subjectScale",
  subjectPosition: "spatialComposition",
  environmentDominance: "spatialComposition",
  negativeSpace: "spatialComposition",
  spatialDepth: "spatialComposition",
  visualDensity: "spatialComposition",
  cameraDistance: "framing",
  cameraHeight: "cameraPosition",
  cameraRelation: "cameraPosition",
  motion: "actionableNotes",
  humanRelation: "actionableNotes",
  socialDistance: "actionableNotes",
  lightDirection: "lighting",
  lightQuality: "lighting",
  colorTemperature: "colorTreatment",
  saturation: "colorTreatment",
  contrast: "colorTreatment",
};

export const GROUP_LABELS = {
  framing: "景别 / 取景",
  subjectScale: "人物尺度",
  cameraPosition: "机位关系",
  spatialComposition: "空间与构图",
  lighting: "光线",
  colorTreatment: "色彩处理",
  actionableNotes: "现场执行要点",
};

// The only text this module can produce. Phrased as actions, never as
// parameters: no focal length, no aperture, no measured distance.
const DECISION = {
  subject: {
    "single-figure": "画面只安排一位主体，不引入第二个人物",
    figure: "以人物为画面主体，安排可见的动作或朝向",
    portrait: "以人物为画面主体，取景向人物上身集中",
    group: "安排多位人物，并明确他们之间的位置关系",
    place: "以场所本身作为主体，让空间承担叙事",
    none: "不安排明确主体，让环境与光线承担叙事",
  },
  subjectScale: {
    small: "让主体在画幅中保持较小占比：把主体放远一些，或用更宽的取景把环境一并收进来",
    medium: "主体与环境比例接近，按常规取景让人物与背景都读得清",
    large: "让主体在画幅中占明显多数：靠近主体，或收紧取景让人物撑满大部分画面",
  },
  subjectPosition: {
    low: "把主体安排在画幅下部，让上方留给天空或远景",
    center: "把主体安排在画幅中心附近",
    high: "把主体安排在画幅上部，让下方留给地面或前景",
    edge: "把主体推到画幅一侧边缘，另一侧留出空间",
  },
  environmentDominance: {
    high: "让环境承担主要叙事：主体不要占满画面，保留地形、天气与周边物体的信息",
    low: "收敛环境信息：背景保持简洁，视线不被杂物带走",
  },
  negativeSpace: {
    high: "保留连续的大面积空白：空白与主体之间留出明确间隔，不要让背景塞满",
    low: "收紧画面：缩短主体与背景元素的距离，让画面元素分布紧凑",
  },
  spatialDepth: {
    deep: "安排前、中、后景层次，让视线有向远处进入的方向",
    shallow: "压缩空间层次，让背景贴近主体，减少纵深",
  },
  visualDensity: {
    sparse: "减少画面元素数量，保持信息稀疏",
    dense: "允许画面元素密集，容纳更多信息",
  },
  cameraDistance: {
    far: "在较远的位置取景，把人物与环境的比例关系一起收进画面",
    medium: "保持中等距离取景，人物与环境各占一半注意力",
    near: "靠近主体取景，让环境退到人物之后",
  },
  cameraHeight: {
    low: "降低机位到接近地面高度，让天空与远景在画幅中占比增大",
    eye: "使用与被摄者视线接近的高度拍摄",
    high: "提高机位俯拍，用以交代人物与周边环境的关系",
  },
  cameraRelation: {
    observational: "保持旁观距离，不进入被摄者的活动空间",
    immersive: "靠近被摄者进入其活动范围，让画面带有参与感",
    confrontational: "正对被摄者与其视线方向，形成对峙的观看关系",
  },
  motion: {
    still: "凝固决定性瞬间，避免动态模糊",
    moving: "捕捉运动中的瞬间，允许轻微的动态感",
  },
  humanRelation: {
    isolated: "让人物与他人保持距离，用空隙表现孤立感",
    together: "让人物之间保持可互动的距离",
    crowd: "安排较密集的人群，但保持彼此不遮挡",
  },
  socialDistance: {
    low: "让人际距离贴近",
    medium: "保持中等的人际距离",
    high: "让人际距离偏远，画面中彼此不相连",
  },
  lightDirection: {
    side: "让光从侧面进入，保留清楚的明暗过渡",
    back: "让光从主体背面来，保留边缘轮廓",
    front: "让光从主体正面来，减少落在主体上的阴影",
    top: "让光从上方来，阴影落在主体下方",
  },
  lightQuality: {
    diffuse: "选择光比柔和的时段或天气，避免生硬的阴影边界",
    directional: "保留清晰的方向性光影，让明暗形状可读",
    rim: "让光在主体边缘形成一圈轮廓亮边",
  },
  colorTemperature: {
    cool: "让整体色温偏冷：避开低角度暖光，或在阴天与阴影中取景",
    warm: "让整体色温偏暖：利用低角度日光或室内暖光源",
    neutral: "保持中性色温，避免明显偏冷或偏暖",
  },
  saturation: {
    low: "降低色彩饱和度，保留灰调与层次",
    medium: "保持中等饱和度，颜色有区分但不刺眼",
    high: "使用鲜明的色彩作为视觉锚点",
  },
  contrast: {
    low: "降低明暗反差，让过渡保持柔和",
    medium: "保持适中的明暗反差",
    high: "强化明暗对比，让亮部与暗部分明",
  },
};

// Negative on-set counterpart of an explicit REMOVE. Same action-first voice.
const PROHIBITION = {
  subjectScale: {
    small: "不要让人物小到与环境无法分辨的比例关系",
    large: "不要让主体占满画面，环境必须同时可读",
  },
  subjectPosition: {
    edge: "不要把主体推到画面边缘导致主体信息被裁切",
  },
  environmentDominance: {
    high: "不要让环境细节压过主体，视线必须回到主体",
  },
  negativeSpace: {
    high: "不要出现大面积空背景，画面需要被内容填充",
    low: "不要把画面塞满，至少保留一块干净空白",
  },
  spatialDepth: {
    deep: "不要刻意拉开前后景层次，保持空间紧凑",
  },
  visualDensity: {
    sparse: "不要减少到信息不足，画面需要足够内容可读",
  },
  cameraDistance: {
    far: "不要为了收环境而让人物小到看不清",
    near: "不要靠得太近，环境关系会消失",
  },
  cameraHeight: {
    low: "不要把机位压得过低以致读不出画面主体",
    high: "不要俯拍到主体变成平面上的一个点",
  },
  motion: {
    still: "不要使用慢门或拖影破坏凝固感",
  },
  lightDirection: {
    back: "不要让主体完全逆光而无轮廓保护",
  },
  lightQuality: {
    rim: "不要让边缘光过强而吞掉主体细节",
  },
  colorTemperature: {
    warm: "不要让暖色主导画面：避开低角度暖光与暖色光源，色温保持偏冷或中性",
    cool: "不要让冷色主导画面，色温保持中性或偏暖",
    neutral: "不要整体偏冷或偏暖，冷暖需保持均衡",
  },
  saturation: {
    low: "不要使用低饱和处理，保留必要的颜色区分",
    high: "不要使用高饱和纯色，避免颜色互相争抢",
  },
  contrast: {
    high: "不要拉大明暗反差，避免暗部完全丢失信息",
  },
  humanRelation: {
    isolated: "不要让人物彼此发生互动，孤立关系必须保持",
  },
};

const FIELD_LABELS = {
  subject: "主体类型",
  subjectScale: "人物尺度",
  subjectPosition: "主体位置",
  environmentDominance: "环境主导",
  negativeSpace: "留白",
  spatialDepth: "空间纵深",
  visualDensity: "信息密度",
  cameraDistance: "取景距离",
  cameraHeight: "机位高度",
  cameraRelation: "观看关系",
  motion: "动势",
  humanRelation: "人物关系",
  socialDistance: "人际距离",
  lightDirection: "光位",
  lightQuality: "光质",
  colorTemperature: "色温",
  saturation: "饱和度",
  contrast: "明暗对比",
};

// Fields that carry no reliable on-set meaning — recorded, never translated.
const NON_SHOOT_FIELDS = new Set([
  "melancholy",
  "arousal",
  "emotion",
  "atmosphere",
  "composition",
  "geometry",
  "source",
  "raw",
]);

const line = (group, text, source, extra = {}) => ({ group, text, source, ...extra });
const srcIntent = (field, value) => `intent:${field}=${value}`;
const srcPrinciple = (field, value, action) => `principle:${field}=${value}#${action}`;

const CURATED_SHOOT_FIELDS = [
  { field: "horizon", group: "spatialComposition", label: "地平线" },
  { field: "mainSubject", group: "spatialComposition", label: "主体位置" },
  { field: "foregroundAnchor", group: "spatialComposition", label: "前景锚点" },
  { field: "leadingLines", group: "spatialComposition", label: "引导线" },
  { field: "vanishingPoint", group: "spatialComposition", label: "消失点" },
  { field: "depthLayers", group: "spatialComposition", label: "景深层次" },
  { field: "cameraHeight", group: "cameraPosition", label: "机位高度" },
  { field: "framing", group: "framing", label: "画幅方向" },
  { field: "light", group: "lighting", label: "光线" },
];

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------

/**
 * translateShoot — deterministic photography decisions for one artwork.
 *
 * @param {object}  options
 * @param {object|null} options.intent     current VisualIntent (null when no task)
 * @param {Array}   options.principles      [{ field, value, action }]
 * @param {object}  options.artwork         current SHOOT artwork (curated, read-only)
 * @param {Array}   options.relations        cinemaRelations(artwork) rows
 * @param {boolean} options.taskFresh        false → caller must use static guides
 * @param {boolean} options.directReference  current artwork is among selectedReferenceKeys
 */
export function translateShoot({
  intent = null,
  principles = [],
  artwork = null,
  relations = [],
  taskFresh = false,
  directReference = false,
} = {}) {
  const groups = {};
  const skipped = [];
  const notes = [];
  const conflicts = [];

  const addLine = (group, text, source, extra = {}) => {
    if (!groups[group]) groups[group] = [];
    groups[group].push(line(group, text, source, extra));
  };

  const usablePrinciples = [];
  for (const entry of principles || []) {
    // Principles are part of the live task: with no fresh task there is
    // nothing to apply and the caller must show the curated static guides.
    if (!taskFresh) {
      skipped.push({ kind: "principle", field: entry && entry.field, value: entry && entry.value, reason: "no-active-task" });
      continue;
    }
    const check = validatePrinciple(entry);
    if (!check.ok) {
      skipped.push({ kind: "principle", field: entry && entry.field, value: entry && entry.value, reason: check.reason });
      continue;
    }
    // A principle is only actionable when we own a template for it.
    if (!SHOOT_FIELDS[entry.field]) {
      skipped.push({
        kind: "principle",
        field: entry.field,
        value: entry.value,
        reason: "no-shooting-template",
      });
      continue;
    }
    usablePrinciples.push(entry);
  }

  const removals = usablePrinciples.filter((p) => p.action === "remove");
  const keeps = usablePrinciples.filter((p) => p.action === "keep");
  const removedPairs = removals.map((p) => `${p.field}=${p.value}`);
  const keptPairs = keeps.map((p) => `${p.field}=${p.value}`);

  // ---- 1. current intent → on-site decisions -----------------------------
  if (taskFresh && intent) {
    for (const [field, values] of Object.entries(SHOOT_FIELDS)) {
      const value = intent[field];
      if (!value || !values.includes(value)) {
        if (value) skipped.push({ kind: "intent-field", field, value, reason: "value-not-in-enum" });
        continue;
      }
      const pair = `${field}=${value}`;
      const group = GROUP_OF[field];
      const text = DECISION[field][value];
      if (!text) {
        skipped.push({ kind: "intent-field", field, value, reason: "no-shooting-template" });
        continue;
      }
      if (removedPairs.includes(pair)) {
        // An explicit REMOVE of the very thing the intent asks for.
        conflicts.push({
          kind: "intent-overridden",
          field,
          value,
          note: `当前意图要求 ${FIELD_LABELS[field]}=${value}，与你 REMOVE 冲突：以显式排除为准，该意图不进入摄影决策。`,
        });
        continue;
      }
      addLine(group, text, srcIntent(field, value));
    }
    for (const field of Object.keys(intent)) {
      if (SHOOT_FIELDS[field]) continue;
      if (NON_SHOOT_FIELDS.has(field)) {
        if (intent[field] && !(Array.isArray(intent[field]) && !intent[field].length)) {
          skipped.push({ kind: "intent-field", field, value: summarise(intent[field]), reason: "no-reliable-shooting-semantics" });
        }
      }
    }
  } else if (!taskFresh) {
    skipped.push({ kind: "task", field: null, value: null, reason: "no-active-task" });
  }

  // ---- 2. explicit KEEP → reinforced on-site requirement -----------------
  for (const principle of keeps) {
    const { field, value } = principle;
    const text = DECISION[field] && DECISION[field][value];
    if (!text) {
      skipped.push({ kind: "principle", field, value, reason: "no-shooting-template" });
      continue;
    }
    const pair = `${field}=${value}`;
    if (removedPairs.includes(pair)) continue; // unreachable: pairs are exclusive
    // A KEEP the intent already states is not repeated verbatim; instead it
    // becomes an explicit must-not-break constraint on location.
    const alreadyFromIntent = Boolean(taskFresh && intent && intent[field] === value);
    if (alreadyFromIntent) {
      notes.push(
        line(
          "actionableNotes",
          `KEEP ${FIELD_LABELS[field]}=${value}：这条已在当前意图中，现场必须保持它不被破坏——${text}`,
          srcPrinciple(field, value, "keep")
        )
      );
    } else {
      addLine(GROUP_OF[field], text, srcPrinciple(field, value, "keep"));
      notes.push(
        line(
          "actionableNotes",
          `KEEP ${FIELD_LABELS[field]}=${value}：按此执行，不因参考作品的其他特征而改变`,
          srcPrinciple(field, value, "keep")
        )
      );
    }
  }

  // ---- 3. explicit REMOVE → negative on-site constraint ------------------
  for (const principle of removals) {
    const { field, value } = principle;
    const text = PROHIBITION[field] && PROHIBITION[field][value];
    if (!text) {
      skipped.push({ kind: "principle", field, value, reason: "no-shooting-prohibition" });
      continue;
    }
    addLine("actionableNotes", `REMOVE ${FIELD_LABELS[field]}=${value}：${text}`, srcPrinciple(field, value, "remove"));
  }

  // ---- 4. curated artwork guidance → supplemental, traceable actions ------
  // Only use the current artwork's place guide. It supplements the live intent;
  // explicit KEEP / REMOVE constraints are authoritative.
  if (taskFresh && artwork?.shootTranslation?.placeGuide) {
    const guide = artwork.shootTranslation.placeGuide;
    const sourceReferenceKey = artwork.key || (artwork.id ? `local:${artwork.id}` : null);
    for (const { field, group, label } of CURATED_SHOOT_FIELDS) {
      const value = guide[field];
      if (typeof value !== "string" || !value.trim()) continue;

      const intentConflict = field === "cameraHeight"
        ? (intent?.cameraHeight === "low" && /高机位|俯拍/.test(value)) ||
          (intent?.cameraHeight === "high" && /低机位|仰拍/.test(value))
        : (field === "horizon" || field === "mainSubject") && intent?.negativeSpace === "low"
          ? /留白|留空|空白/.test(value)
          : field === "depthLayers"
            ? (intent?.spatialDepth === "deep" && /不分层|无层次|不需要.*层/.test(value)) ||
              (intent?.spatialDepth === "shallow" && /前景.*中景.*背景|层层/.test(value))
            : false;
      const principleConflict = field === "light" &&
        removals.some((p) => p.field === "colorTemperature" && p.value === "warm") && /暖光|暖色/.test(value);
      if (intentConflict || principleConflict) {
        conflicts.push({
          kind: "curated-guidance-overridden",
          field,
          value: label,
          sourceReferenceKey,
          sourceField: `shootTranslation.placeGuide.${field}`,
          note: `作品专属建议“${label}”与当前意图或显式排除冲突，已跳过并以用户约束为准。`,
        });
        continue;
      }
      addLine(
        group,
        `${label}（作品补充）：${value.trim()}`,
        `artwork:${sourceReferenceKey}:${field}`,
        { sourceReferenceKey, sourceField: `shootTranslation.placeGuide.${field}` }
      );
    }
  } else if (taskFresh) {
    skipped.push({ kind: "artwork-guidance", field: "shootTranslation.placeGuide", value: null, reason: "no-curated-place-guide" });
  }

  // ---- 5. relations → explicitly-classified, non-prescriptive notes -----
  const provenance = [];
  for (const relation of relations || []) {
    const evidence = relation.evidenceLevel || null;
    const relationClass = relation.relationClass || "解释性关联";
    if (relationClass === "明确引用") {
      provenance.push({
        kind: "documented",
        film: relation.filmTitleZh || relation.filmTitle,
        relationType: relation.relationType,
        evidence,
      });
    } else if (relationClass === "视觉平行") {
      provenance.push({
        kind: "visual-parallel",
        film: relation.filmTitleZh || relation.filmTitle,
        relationType: relation.relationType,
        evidence,
        note: `视觉平行：可参照《${relation.filmTitleZh || relation.filmTitle}》在${parallelAspect(relation.relationType)}上的处理方式，但这不表示该片导演受本画影响。`,
      });
    } else {
      provenance.push({
        kind: "thematic",
        film: relation.filmTitleZh || relation.filmTitle,
        relationType: relation.relationType,
        evidence,
        note: "解释性关联：仅为主题联想，不构成拍摄执行依据。",
      });
    }
  }

  // ---- assemble ----------------------------------------------------------
  const decisions = {};
  for (const [group, lines] of Object.entries(groups)) {
    if (lines.length) decisions[group] = lines;
  }
  if (notes.length) {
    decisions.actionableNotes = [...(decisions.actionableNotes || []), ...notes];
  }
  if (!Object.keys(decisions).length) {
    skipped.push({ kind: "output", field: null, value: null, reason: "no-reliable-shooting-input" });
  }

  return {
    artworkId: artwork ? artwork.id : null,
    taskFresh,
    directReference,
    decisions,
    provenance,
    conflicts,
    skipped,
  };
}

function parallelAspect(relationType) {
  switch (relationType) {
    case "COMPOSITIONAL_PARALLEL":
      return "构图";
    case "LIGHTING_PARALLEL":
      return "光线";
    case "COLOR_PARALLEL":
      return "色彩";
    case "SPATIAL_PARALLEL":
      return "空间";
    default:
      return "视觉";
  }
}

function summarise(value) {
  if (Array.isArray(value)) return value.join("/");
  return String(value);
}
