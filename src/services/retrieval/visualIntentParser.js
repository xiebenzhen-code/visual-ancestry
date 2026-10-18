// parseVisualIntent — rule-based text → VisualIntent.
// Not a model. If a phrase is not covered, the field stays empty.
import { emptyVisualIntent, mergeIntent } from "./visualIntent.js";

const RULES = [
  {
    test: /一个人|单人|独自|alone|one person|a figure/,
    patch: { subject: "single-figure", socialDistance: "high", humanRelation: "isolated" },
  },
  {
    test: /很大的空间|辽阔|空旷|vast|huge space|enormous|wide open/,
    patch: {
      subjectScale: "small",
      environmentDominance: "high",
      spatialDepth: "deep",
      negativeSpace: "high",
      atmosphere: ["空旷"],
    },
  },
  {
    test: /很远|远处|远景|distant|far away|tiny figure/,
    patch: {
      subjectScale: "small",
      cameraDistance: "far",
      cameraRelation: "observational",
      spatialDepth: "deep",
    },
  },
  {
    test: /不是悲伤|不要悲伤|不悲伤|not sad|not melancholy|不要忧郁/,
    patch: { melancholy: "low", emotion: ["平静"] },
  },
  {
    test: /悲伤|忧郁|sad|melancholy|grief/,
    patch: { melancholy: "high", emotion: ["悲伤"], arousal: "low" },
  },
  {
    test: /安静|平静|静止|calm|still|quiet/,
    patch: { arousal: "low", motion: "still", atmosphere: ["寂静"] },
  },
  {
    test: /侧光|从侧面|side light|raking/,
    patch: { lightDirection: "side", lightQuality: "directional" },
  },
  {
    test: /逆光|背光|backlight|contre-jour/,
    patch: { lightDirection: "back", lightQuality: "rim" },
  },
  {
    test: /低饱和|灰|muted|desaturated/,
    patch: { saturation: "low" },
  },
  {
    test: /夜晚|夜|night|nocturne/,
    patch: { atmosphere: ["夜晚"], colorTemperature: "cool", contrast: "high" },
  },
  {
    test: /雾|雾气|fog|mist|haze/,
    patch: { atmosphere: ["雾"], lightQuality: "diffuse", contrast: "low", spatialDepth: "deep" },
  },
  {
    test: /留白|空白|negative space|empty/,
    patch: { negativeSpace: "high", visualDensity: "sparse" },
  },
  {
    test: /拥挤|密集|crowd|dense/,
    patch: { visualDensity: "dense", subjectScale: "medium", socialDistance: "low" },
  },
];

export function parseVisualIntent(text) {
  const source = String(text || "").trim();
  let intent = emptyVisualIntent();
  intent.source = "text";
  intent.raw = source;
  if (!source) return intent;

  const emotions = new Set();
  const atmospheres = new Set();
  for (const rule of RULES) {
    if (!rule.test.test(source)) continue;
    const patch = { ...rule.patch };
    if (patch.emotion) {
      patch.emotion.forEach((item) => emotions.add(item));
      delete patch.emotion;
    }
    if (patch.atmosphere) {
      patch.atmosphere.forEach((item) => atmospheres.add(item));
      delete patch.atmosphere;
    }
    intent = mergeIntent(intent, patch);
  }
  intent.emotion = [...emotions];
  intent.atmosphere = [...atmospheres];

  // The required example must not collapse into "lonely + empty".
  if (/不是悲伤|不要悲伤|不悲伤|not sad/.test(source)) {
    intent.melancholy = "low";
    intent.emotion = intent.emotion.filter((item) => item !== "悲伤" && item !== "孤独");
  }
  if (/一个人/.test(source) && /很大|辽阔|空旷|很远/.test(source)) {
    intent.subjectScale = "small";
    intent.environmentDominance = "high";
    intent.spatialDepth = "deep";
    intent.negativeSpace = "high";
    intent.arousal = intent.arousal || "low";
    intent.socialDistance = "high";
    intent.cameraRelation = "observational";
  }
  return intent;
}

export function intentSummary(intent) {
  return Object.entries(intent)
    .filter(([key, value]) => !["source", "raw", "emotion", "atmosphere"].includes(key))
    .filter(([, value]) => value && !(Array.isArray(value) && !value.length))
    .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join("/") : value}`);
}
