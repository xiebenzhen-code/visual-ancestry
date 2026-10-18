// P5.3.1 — visualProfile: the ONLY profile aggregator in the personal layer.
//
// One job:  VisualMemory[] → aggregateVisualProfile() → VisualProfile
//
// Boundary (P5.3.0 audit):
//   - READ-ONLY over the frozen visualIntent schema — no scoring, no weights,
//     no retrieval imports, no model, no embedding.
//   - Admission mirrors the retrieval contract (P5.2.1): status === "success"
//     && visualIntent.source !== "empty" (and !== "example"). Failed assets and
//     placeholders are NOT visual assets.
//   - metadata (title/tags/note) NEVER participates — profile reads intent only.
//   - Aggregation is COUNTING, not scoring: every value is a pool share.
//   - Naming: deliberately `visualProfile.js`, NOT `profile.js` (that name is
//     taken by the Phase-2 browsing-behavior log; the two never mix).
//
// Honesty rules (P5.3.0 §4): sparse/empty/degenerate fields are reported in
// `unavailable` computed FROM the data — never silently dropped, never faked.

// ---- Confidence layer (fixed thresholds, P5.3.1 STEP 2) --------------------
// 0 → empty · 1-19 → observation · 20-50 → tendency · 50+ → pattern
export function getConfidence(sampleSize) {
  if (!Number.isFinite(sampleSize) || sampleSize <= 0) {
    return { level: "empty", basis: "no visual memories yet" };
  }
  if (sampleSize < 20) {
    return { level: "observation", basis: `based on ${sampleSize} visual memories` };
  }
  if (sampleSize <= 50) {
    return { level: "tendency", basis: `based on ${sampleSize} visual memories` };
  }
  return { level: "pattern", basis: `based on ${sampleSize} visual memories` };
}

// ---- admission (same contract as retrieval, no import from it) -------------
export function isProfileEligible(memory) {
  return !!(
    memory &&
    memory.status === "success" &&
    memory.visualIntent &&
    memory.visualIntent.source !== "empty" &&
    memory.visualIntent.source !== "example"
  );
}

// ---- share helper: {count, ratio} with 2-decimal ratio ---------------------
// empty pool → 0/0 is NaN; honesty demands 0.00, not NaN (never fake a share)
function share(pool, field, value) {
  const count = pool.filter((m) => m.visualIntent[field] === value).length;
  return { count, ratio: pool.length ? Number((count / pool.length).toFixed(2)) : 0 };
}

// ---- honesty detection: which fields CANNOT support a claim ---------------
function computeUnavailable(pool) {
  const n = pool.length;
  const unavailable = {};

  // list fields: coverage = entries with ≥1 token
  for (const field of ["emotion", "atmosphere"]) {
    const nonEmpty = pool.filter(
      (m) => Array.isArray(m.visualIntent[field]) && m.visualIntent[field].length > 0
    ).length;
    if (nonEmpty === 0) {
      unavailable[field] = "无任何氛围/情绪词产出，无法呈现";
    } else if (nonEmpty / n < 0.5) {
      unavailable[field] = `仅 ${nonEmpty}/${n} 条有产出（${Math.round((nonEmpty / n) * 100)}%），样本不足`;
    }
  }

  // scalar fields: all-empty or degenerate (top value ≥ 90%)
  for (const field of [
    "composition", "geometry", "lightDirection", "cameraHeight", "cameraRelation",
  ]) {
    const values = pool.map((m) => m.visualIntent[field]).filter((v) => v !== "" && v != null);
    if (values.length === 0) {
      unavailable[field] = "冻结 Vision 层未产出该字段，无法呈现";
      continue;
    }
    const counts = new Map();
    for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
    const top = Math.max(...counts.values());
    if (top / n >= 0.9) {
      unavailable[field] = `取值高度单一（${Math.round((top / n) * 100)}% 同值），无区分度`;
    }
  }
  return unavailable;
}

// ---- main entry (pure; pass listMemories() result in) ----------------------
export function aggregateVisualProfile(memories) {
  const pool = (Array.isArray(memories) ? memories : []).filter(isProfileEligible);
  const n = pool.length;

  const profile = {
    sampleSize: n,
    confidence: getConfidence(n),
    sampleSource: "personal-pool", // browsing behavior (#eye) never mixes in

    spatial: {
      deepSpace: share(pool, "spatialDepth", "deep"),
      environmentDominant: share(pool, "environmentDominance", "high"),
      negativeSpaceHigh: share(pool, "negativeSpace", "high"),
    },
    composition: {
      centeredSubject: share(pool, "subjectPosition", "center"),
      farCamera: share(pool, "cameraDistance", "far"),
      staticFrame: share(pool, "motion", "still"),
    },
    color: {
      lowSaturation: share(pool, "saturation", "low"),
      neutralTone: share(pool, "colorTemperature", "neutral"),
      coolTone: share(pool, "colorTemperature", "cool"),
      warmTone: share(pool, "colorTemperature", "warm"),
      highContrast: share(pool, "contrast", "high"),
    },
    narrative: {
      isolation: share(pool, "humanRelation", "isolated"),
      socialDistanceHigh: share(pool, "socialDistance", "high"),
      quietArousal: share(pool, "arousal", "low"),
      melancholyMedium: share(pool, "melancholy", "medium"),
    },

    // atmosphere is sparse-but-present: token counts shown with the coverage
    // note the presenter must render (emotion, if under 50%, lands in unavailable)
    atmosphereTokens: (() => {
      const tokens = {};
      for (const m of pool) {
        for (const t of m.visualIntent.atmosphere || []) tokens[t] = (tokens[t] || 0) + 1;
      }
      return tokens;
    })(),
    atmosphereCoverage: Number(
      (
        pool.filter((m) => Array.isArray(m.visualIntent.atmosphere) && m.visualIntent.atmosphere.length > 0)
          .length / (n || 1)
      ).toFixed(2)
    ),

    unavailable: computeUnavailable(pool),
    generatedAt: new Date().toISOString(),
  };
  return profile;
}

// ---- convenience entry for the page (async, reads the real pool) ----------
export async function buildVisualProfile() {
  const { listMemories } = await import("./memoryRepository.js");
  return aggregateVisualProfile(await listMemories());
}
