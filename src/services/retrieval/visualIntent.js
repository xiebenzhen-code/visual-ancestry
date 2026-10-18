// VisualIntent — the retrieval query, not a mood tag.
// Emotion is one field among spatial, light, color, camera and motion.

export function emptyVisualIntent() {
  return {
    emotion: [],
    atmosphere: [],
    subject: "",
    subjectScale: "",
    subjectPosition: "",
    spatialDepth: "",
    negativeSpace: "",
    environmentDominance: "",
    composition: "",
    geometry: "",
    lightDirection: "",
    lightQuality: "",
    colorTemperature: "",
    saturation: "",
    contrast: "",
    humanRelation: "",
    cameraDistance: "",
    cameraHeight: "",
    cameraRelation: "",
    motion: "",
    visualDensity: "",
    arousal: "",
    socialDistance: "",
    melancholy: "",
    source: "empty",
  };
}

export function mergeIntent(base, patch) {
  const next = { ...base };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value) && !value.length) continue;
    next[key] = value;
  }
  return next;
}
