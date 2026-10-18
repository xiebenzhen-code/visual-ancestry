// normalizeVisionIntent — untrusted provider JSON → a real VisualIntent.
//
// Rules:
//   - only fields that already exist on VisualIntent are kept (no imageIntent)
//   - a value is kept only if it is one of that field's known tokens
//   - anything else (unknown field, unknown token, null, "", "unknown") is dropped
//   - nothing is invented to fill the schema; a partial result stays partial
//   - emotion stays one list dimension, it is not promoted
//
// Returns null when the payload is not an object at all (malformed), so the
// caller can tell "garbage" apart from "an honest empty reading".
import { emptyVisualIntent, mergeIntent } from "../retrieval/visualIntent.js";

const ENUMS = {
  subject: ["single-figure", "figure", "portrait", "group", "place", "none"],
  subjectScale: ["small", "medium", "large"],
  subjectPosition: ["low", "center", "high", "edge"],
  spatialDepth: ["deep", "shallow"],
  negativeSpace: ["high", "low"],
  environmentDominance: ["high", "low"],
  lightDirection: ["side", "back", "front", "top"],
  lightQuality: ["diffuse", "directional", "rim"],
  colorTemperature: ["cool", "warm", "neutral"],
  saturation: ["low", "medium", "high"],
  contrast: ["low", "medium", "high"],
  humanRelation: ["isolated", "together", "crowd"],
  cameraDistance: ["far", "medium", "near"],
  cameraHeight: ["low", "eye", "high"],
  cameraRelation: ["observational", "immersive", "confrontational"],
  motion: ["still", "moving"],
  visualDensity: ["sparse", "dense"],
  arousal: ["low", "medium", "high"],
  socialDistance: ["low", "medium", "high"],
  melancholy: ["low", "medium", "high"],
};

const LISTS = {
  emotion: ["平静", "悲伤", "孤独", "喜悦", "敬畏", "不安", "温暖"],
  atmosphere: ["空旷", "寂静", "夜晚", "雾", "热闹", "阴郁"],
};

function keep(value, allowed) {
  return allowed.includes(value) ? value : "";
}

export function normalizeVisionIntent(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const patch = { source: "vision" };
  for (const [field, allowed] of Object.entries(ENUMS)) {
    const value = keep(raw[field], allowed);
    if (value) patch[field] = value;
  }
  for (const [field, allowed] of Object.entries(LISTS)) {
    const list = Array.isArray(raw[field]) ? raw[field].filter((item) => allowed.includes(item)) : [];
    if (list.length) patch[field] = list;
  }
  return mergeIntent(emptyVisualIntent(), patch);
}
