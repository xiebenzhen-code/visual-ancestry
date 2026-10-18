// Field overlap score. This is a retrieval score, not a model confidence.
const WEIGHTS = {
  subject: 1.5, // P3.1: the single-figure/group/portrait/place axis now scores.
  subjectScale: 3,
  environmentDominance: 3,
  spatialDepth: 2.5,
  negativeSpace: 2.5,
  lightDirection: 2,
  lightQuality: 1.5,
  saturation: 1.5,
  contrast: 1.2,
  cameraRelation: 2,
  cameraDistance: 1.5,
  cameraHeight: 1,
  socialDistance: 2,
  humanRelation: 1.5,
  motion: 1,
  visualDensity: 1.2,
  colorTemperature: 1,
  melancholy: 2,
  arousal: 1,
};

export function scoreIntent(query, candidate) {
  let score = 0;
  let possible = 0;
  for (const [field, weight] of Object.entries(WEIGHTS)) {
    if (!query[field]) continue;
    possible += weight;
    if (candidate[field] && candidate[field] === query[field]) score += weight;
  }
  for (const emotion of query.emotion || []) {
    possible += 0.6;
    if ((candidate.emotion || []).includes(emotion)) score += 0.6;
  }
  for (const atmosphere of query.atmosphere || []) {
    possible += 0.8;
    if ((candidate.atmosphere || []).includes(atmosphere)) score += 0.8;
  }
  // Explicit "not sad" must not reward melancholy artworks.
  if (query.melancholy === "low" && (candidate.emotion || []).some((item) => /悲伤|忧郁/.test(item))) {
    score -= 2;
  }
  return {
    score: Math.round(score * 10) / 10,
    possible: Math.round(possible * 10) / 10,
  };
}
